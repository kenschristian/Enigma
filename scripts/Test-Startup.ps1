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
    function Get-ScheduledTask { param([string]$TaskName) return [pscustomobject]@{ State = $taskStates.Dequeue() } }
    function Get-ScheduledTaskInfo { param([string]$TaskName) return [pscustomobject]@{ LastTaskResult = 1 } }
    function Stop-ScheduledTask { param([string]$TaskName) }
    function Start-ScheduledTask { param([string]$TaskName) }
    function Start-Sleep { param([int]$Milliseconds) }
    $detectedFailure = $false
    try {
        & (Join-Path $PSScriptRoot 'Restart-Agents.ps1')
    } catch {
        if ($_.Exception.Message -notmatch 'exited during startup \(task result 1\)') { throw }
        $detectedFailure = $true
    } finally {
        foreach ($name in @('Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Stop-ScheduledTask', 'Start-ScheduledTask', 'Start-Sleep')) { Remove-Item -LiteralPath ('Function:\' + $name) }
    }
    if (-not $detectedFailure) { throw 'Restart reported success for a runner that immediately exited.' }
    Write-Host 'PASS: physical paths, projects, idempotence, unchanged credentials, child exit propagation, safe diagnostics, and failed-start detection.'
} finally {
    # All paths are inside this fresh fixture. Preserve unrelated files and dirs.
    foreach ($name in @('config.json', 'runtime.json', 'secrets.json', 'runner.log', 'runner.log.1', 'config.json.new', 'runtime.json.new')) {
        $fixture = Join-Path $testRoot $name
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Force }
    }
    foreach ($directory in @($stateDir, $worktreesRoot, $testRoot)) {
        if (Test-Path -LiteralPath $directory) { [IO.Directory]::Delete($directory, $false) }
    }
}
# Expected child failures above must not become the CI wrapper's final exit code.
exit 0
