#Requires -Version 5.1
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'Resolve-StartupPaths.ps1')
$testRoot = Assert-PrivatePath (Join-Path (Get-EnigmaHome) ('startup-test-' + [guid]::NewGuid().ToString('N')))
$configPath = Join-Path $testRoot 'config.json'
$runtimePath = Join-Path $testRoot 'runtime.json'
$secretsPath = Join-Path $testRoot 'secrets.json'
$stateDir = Join-Path $testRoot 'state'
$worktreesRoot = Join-Path $testRoot 'worktrees'
$fixtureProcess = $null
$fixtureDescendant = $null
$verifiedChild = $null
try {
    [void](Initialize-PrivateDirectory $testRoot)
    [void](Initialize-PrivateDirectory $stateDir)
    [void](Initialize-PrivateDirectory $worktreesRoot)
    $repoPath = Split-Path -Parent $PSScriptRoot
    $node = Find-EnigmaExecutable 'node.exe' @((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
    # Deliberately invalid application version: the wrapper can launch Node but
    # application validation must fail before any account or Slack network activity.
    $settings = @{ version = 0; repoPath = $repoPath; stateDir = $stateDir; worktreesRoot = $worktreesRoot; codexCommand = $node; bots = @(); projects = @(@{ key = 'fixture'; repoPath = $repoPath }) }
    Write-PrivateJson $configPath $settings
    Write-PrivateJson $runtimePath @{ nodeCommand = $node }
    Write-PrivateJson $secretsPath @{}
    $secretHash = (Get-FileHash -LiteralPath $secretsPath).Hash
    $resolvedConfig = Resolve-EnigmaStartupPaths $configPath
    $recordPath = Join-Path (Split-Path -Parent $resolvedConfig) 'runner-process.json'
    $firstMetadata = [IO.File]::ReadAllText($resolvedConfig)
    $resolvedAgain = Resolve-EnigmaStartupPaths $resolvedConfig
    if ($resolvedConfig -cne $resolvedAgain -or $firstMetadata -cne [IO.File]::ReadAllText($resolvedAgain)) { throw 'Startup normalization must be idempotent.' }
    $normalized = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
    if ($normalized.stateDir -cne (Get-EnigmaPhysicalPath $stateDir) -or $normalized.worktreesRoot -cne (Get-EnigmaPhysicalPath $worktreesRoot)) { throw 'Private paths did not resolve to the existing physical directories.' }
    if ($normalized.projects[0].repoPath -cne (Get-EnigmaPhysicalPath $repoPath)) { throw 'Project repository path was not normalized.' }
    if ((Get-FileHash -LiteralPath $secretsPath).Hash -cne $secretHash) { throw 'Normalization changed the synthetic credential file.' }

    $output = @(& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $resolvedConfig -Doctor *>&1) -join "`n"
    if ($LASTEXITCODE -ne 1) { throw 'The wrapper must return the failing application exit code.' }
    $logPath = Join-Path (Split-Path -Parent $resolvedConfig) 'runner.log'
    $log = Get-Content -LiteralPath $logPath -Raw
    if ($log -notmatch 'event=child-started childPid=\d+' -or $log -notmatch 'event=child-exited exitCode=1') { throw 'Child lifecycle diagnostics are missing.' }
    if ($output -match 'VoidTaskResult') { throw 'Internal stream-drain task results leaked to output.' }

    # A normal failing child must clear its own record; doctor must leave another
    # runner's provenance untouched. No synthetic configuration has valid tokens.
    $output = @(& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $resolvedConfig *>&1) -join "`n"
    if ($LASTEXITCODE -ne 1 -or (Test-Path -LiteralPath $recordPath)) { throw 'Exited runner provenance was not cleaned up.' }
    $log = Get-Content -LiteralPath $logPath -Raw
    if ([regex]::Matches($log, 'event=child-started childPid=\d+').Count -ne 2) { throw 'The normal runner failed before recording its child.' }
    Write-PrivateJson $recordPath @{ version = 1; processId = 1; creationUtcTicks = '1' }
    $recordBeforeDoctor = [IO.File]::ReadAllText($recordPath)
    $output = @(& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $resolvedConfig -Doctor *>&1) -join "`n"
    if ([IO.File]::ReadAllText($recordPath) -cne $recordBeforeDoctor) { throw 'Doctor changed another runner process record.' }
    Remove-Item -LiteralPath $recordPath

    . (Join-Path $PSScriptRoot 'Restart-Agents.ps1')
    $fixtureMain = Join-Path $testRoot 'runner-fixture.mjs'
    $otherConfig = Join-Path $testRoot 'other-config.json'
    [IO.File]::WriteAllText($fixtureMain, 'import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs"; const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore", windowsHide:true, detached:true}); writeFileSync(process.argv[3]+".childpid", String(child.pid)); child.unref(); setInterval(() => {}, 1000);')
    Write-PrivateJson $otherConfig @{}
    $fixtureStart = New-Object Diagnostics.ProcessStartInfo
    $fixtureStart.FileName = $node
    $fixtureStart.Arguments = (@($fixtureMain, '--config', $resolvedConfig) | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $fixtureStart.UseShellExecute = $false
    $fixtureStart.CreateNoWindow = $true
    $fixtureProcess = New-Object Diagnostics.Process
    $fixtureProcess.StartInfo = $fixtureStart
    [void]$fixtureProcess.Start()
    $childPidPath = $resolvedConfig + '.childpid'
    $childDeadline = (Get-Date).AddSeconds(5)
    while (-not (Test-Path -LiteralPath $childPidPath) -and (Get-Date) -lt $childDeadline) { Start-Sleep -Milliseconds 25 }
    $fixtureDescendant = Get-Process -Id ([int][IO.File]::ReadAllText($childPidPath))
    [void]$fixtureDescendant.Handle
    $record = @{
        version = 1; processId = $fixtureProcess.Id
        creationUtcTicks = $fixtureProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        nodePath = Get-EnigmaPhysicalPath $node; mainPath = Get-EnigmaPhysicalPath $fixtureMain
        configPath = Get-EnigmaPhysicalPath $resolvedConfig
    }
    # Simulate PID reuse, forged main/config mappings, and a command line which
    # differs from the stored expected config. Every refusal must leave it alive.
    foreach ($mismatch in @('creation', 'main', 'config', 'arguments')) {
        $candidate = $record.Clone()
        $expectedConfig = $resolvedConfig
        switch ($mismatch) {
            'creation' { $candidate.creationUtcTicks = ([long]$record.creationUtcTicks + 1).ToString() }
            'main' { $candidate.mainPath = $otherConfig }
            'config' { $candidate.configPath = $otherConfig }
            'arguments' { $candidate.configPath = $otherConfig; $expectedConfig = $otherConfig }
        }
        Write-PrivateJson $recordPath $candidate
        $refused = $false
        try { $unexpected = Get-EnigmaRecordedChild $recordPath $node $fixtureMain $expectedConfig }
        catch {
            if ($_.Exception.Message -notmatch 'identity could not be verified') { throw }
            $refused = $true
        }
        if (-not $refused -or $fixtureProcess.HasExited -or -not (Test-Path -LiteralPath $recordPath)) { throw ('Unsafe process mismatch handling: ' + $mismatch) }
    }
    Write-PrivateJson $recordPath $record
    $recordBeforeDuplicate = [IO.File]::ReadAllText($recordPath)
    $output = @(& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $resolvedConfig *>&1) -join "`n"
    if ($LASTEXITCODE -ne 1 -or $fixtureProcess.HasExited -or [IO.File]::ReadAllText($recordPath) -cne $recordBeforeDuplicate) { throw 'Duplicate startup replaced a live runner record.' }
    # Expected paths can be logical AppData aliases; recorded paths are physical.
    $verifiedChild = Get-EnigmaRecordedChild $recordPath $node $fixtureMain $resolvedConfig
    if (-not $verifiedChild.Process -or $verifiedChild.Descendants.Id -notcontains $fixtureDescendant.Id) { throw 'The synthetic orphan and its child were not found.' }
    $replacedRecord = $record.Clone()
    $replacedRecord.creationUtcTicks = ([long]$record.creationUtcTicks + 1).ToString()
    Write-PrivateJson $recordPath $replacedRecord
    Remove-EnigmaMatchingProcessRecord $recordPath $record
    if (-not (Test-Path -LiteralPath $recordPath)) { throw 'A replaced process record was removed.' }
    Write-PrivateJson $recordPath $record
    $fixtureProcess.Kill()
    [void]$fixtureProcess.WaitForExit(5000)
    if ($fixtureDescendant.HasExited) { throw 'The surviving-child fixture exited too soon.' }
    Stop-EnigmaRecordedChild $verifiedChild $recordPath
    if (-not $fixtureDescendant.WaitForExit(5000) -or (Test-Path -LiteralPath $recordPath)) { throw 'The verified surviving child was not stopped and cleared.' }
    foreach ($descendant in $verifiedChild.Descendants) { $descendant.Dispose() }
    $verifiedChild.Process.Dispose()
    $verifiedChild = $null
    $fixtureProcess.Dispose()
    $fixtureProcess = $null
    $fixtureDescendant.Dispose()
    $fixtureDescendant = $null
    Remove-Item -LiteralPath $childPidPath
    # Also exercise successful taskkill /T while the verified root remains alive.
    [IO.File]::WriteAllText($fixtureMain, 'setInterval(() => {}, 1000);')
    $fixtureProcess = [Diagnostics.Process]::Start($fixtureStart)
    $record.processId = $fixtureProcess.Id
    $record.creationUtcTicks = $fixtureProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    Write-PrivateJson $recordPath $record
    $verifiedChild = Get-EnigmaRecordedChild $recordPath $node $fixtureMain $resolvedConfig
    Stop-EnigmaRecordedChild $verifiedChild $recordPath
    if (-not $fixtureProcess.HasExited -or (Test-Path -LiteralPath $recordPath)) { throw 'Verified live-root cleanup failed.' }
    Write-PrivateJson $recordPath $record
    $absentRefused = $false
    try { $unexpected = Get-EnigmaRecordedChild $recordPath $node $fixtureMain $resolvedConfig }
    catch {
        if ($_.Exception.Message -notmatch 'identity could not be verified') { throw }
        $absentRefused = $true
    }
    if (-not $absentRefused -or -not (Test-Path -LiteralPath $recordPath)) { throw 'An absent root was treated as proof of a clean process tree.' }
    $output = @(& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $resolvedConfig *>&1) -join "`n"
    # Normal logon startup must replace records left over from a prior OS boot.
    if ($LASTEXITCODE -ne 1 -or (Test-Path -LiteralPath $recordPath)) { throw 'Normal startup could not replace stale provenance.' }
    $verifiedChild.Process.Dispose()
    $verifiedChild = $null
    $fixtureProcess.Dispose()
    $fixtureProcess = $null

    $canary = 'synthetic-private-value-never-log'
    [IO.File]::WriteAllText($resolvedConfig, ('{"broken":"' + $canary))
    $output = @(& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $resolvedConfig -Doctor *>&1) -join "`n"
    $log = Get-Content -LiteralPath $logPath -Raw
    if ($LASTEXITCODE -ne 1 -or $log -notmatch 'stage=configuration-read event=failed type=[\w.]+ hresult=-?\d+') { throw 'Safe wrapper-failure diagnostics are missing.' }
    if (($output + $log).Contains($canary)) { throw 'Private parser content leaked to diagnostic output.' }
    # Simulate a registered runner that exits immediately after start. The real
    # restart script must report failure; these mocks never contact Task Scheduler.
    $taskStates = New-Object 'Collections.Generic.Queue[string]'
    foreach ($state in @('Ready', 'Ready', 'Running', 'Ready')) { $taskStates.Enqueue($state) }
    $fixtureAction = [pscustomobject]@{
        Execute = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        Arguments = '-NoProfile -File ' + (ConvertTo-WindowsArgument (Join-Path $PSScriptRoot 'Start-Agents.ps1')) + ' -Config ' + (ConvertTo-WindowsArgument $resolvedConfig)
    }
    function Get-ScheduledTask { param([string]$TaskName) return [pscustomobject]@{ State = $taskStates.Dequeue(); Actions = @($fixtureAction) } }
    function Get-ScheduledTaskInfo { param([string]$TaskName) return [pscustomobject]@{ LastTaskResult = 1 } }
    $fixtureCalls = @{ stop = 0; start = 0 }
    function Stop-ScheduledTask { param([string]$TaskName) $fixtureCalls.stop++ }
    function Start-ScheduledTask { param([string]$TaskName) $fixtureCalls.start++ }
    function Start-Sleep { param([int]$Milliseconds) }
    $detectedFailure = $false
    try {
        # A partial cleanup failure must still cancel scheduled retry policy,
        # while never requesting a replacement runner. All process APIs are mocked.
        $getChildBody = (Get-Item Function:\Get-EnigmaRecordedChild).ScriptBlock
        $stopChildBody = (Get-Item Function:\Stop-EnigmaRecordedChild).ScriptBlock
        try {
            function Get-EnigmaRecordedChild { return [pscustomobject]@{ Process = $null; Descendants = @() } }
            function Stop-EnigmaRecordedChild { throw 'Synthetic cleanup failure.' }
            Write-PrivateJson $recordPath @{}
            $taskStates.Clear()
            $taskStates.Enqueue('Running')
            $cleanupRefused = $false
            try { Invoke-EnigmaRestart $resolvedConfig }
            catch {
                if ($_.Exception.Message -cne 'Synthetic cleanup failure.') { throw }
                $cleanupRefused = $true
            }
            if (-not $cleanupRefused -or $fixtureCalls.stop -ne 1 -or $fixtureCalls.start -ne 0) { throw 'Failed cleanup did not cancel retries and refuse replacement.' }
        } finally {
            Set-Item Function:\Get-EnigmaRecordedChild $getChildBody
            Set-Item Function:\Stop-EnigmaRecordedChild $stopChildBody
            Remove-Item -LiteralPath $recordPath
            $fixtureCalls.stop = 0
        }
        # A legacy active runner lacking provenance must be left running.
        $taskStates.Clear()
        $taskStates.Enqueue('Running')
        $legacyRefused = $false
        try { & (Join-Path $PSScriptRoot 'Restart-Agents.ps1') }
        catch {
            if ($_.Exception.Message -notmatch 'no verified process record') { throw }
            $legacyRefused = $true
        }
        if (-not $legacyRefused -or $fixtureCalls.stop -ne 0) { throw 'Restart stopped an unverified legacy runner.' }
        foreach ($state in @('Ready', 'Ready', 'Running', 'Ready')) { $taskStates.Enqueue($state) }
        & (Join-Path $PSScriptRoot 'Restart-Agents.ps1')
    } catch {
        if ($_.Exception.Message -notmatch 'exited during startup \(task result 1\)') { throw }
        $detectedFailure = $true
    } finally {
        foreach ($name in @('Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Stop-ScheduledTask', 'Start-ScheduledTask', 'Start-Sleep')) { Remove-Item -LiteralPath ('Function:\' + $name) }
    }
    if (-not $detectedFailure) { throw 'Restart reported success for a runner that immediately exited.' }
    Write-Host 'PASS: physical paths, child exit propagation, safe diagnostics, orphan recovery, PID/argv mismatch refusal, record preservation, legacy runner protection, and failed-start detection.'
} finally {
    if ($verifiedChild) {
        foreach ($descendant in $verifiedChild.Descendants) { $descendant.Dispose() }
        if ($verifiedChild.Process) { $verifiedChild.Process.Dispose() }
    }
    if ($fixtureProcess) {
        if (-not $fixtureProcess.HasExited) { $fixtureProcess.Kill(); [void]$fixtureProcess.WaitForExit(5000) }
        $fixtureProcess.Dispose()
    }
    if ($fixtureDescendant) {
        if (-not $fixtureDescendant.HasExited) { $fixtureDescendant.Kill(); [void]$fixtureDescendant.WaitForExit(5000) }
        $fixtureDescendant.Dispose()
    }
    # All paths are inside this fresh fixture. Preserve unrelated files and dirs.
    foreach ($name in @('config.json', 'runtime.json', 'secrets.json', 'runner.log', 'runner.log.1', 'config.json.new', 'runtime.json.new', 'runner-process.json', 'runner-process.json.new', 'runner-fixture.mjs', 'other-config.json', 'config.json.childpid')) {
        $fixture = Join-Path $testRoot $name
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Force }
    }
    $fixtureLock = Join-Path $stateDir 'runner.lock'
    if (Test-Path -LiteralPath $fixtureLock) { Remove-Item -LiteralPath $fixtureLock -Force }
    foreach ($directory in @($stateDir, $worktreesRoot, $testRoot)) {
        if (Test-Path -LiteralPath $directory) { [IO.Directory]::Delete($directory, $false) }
    }
}
# Expected child failures above must not become the CI wrapper's final exit code.
exit 0
