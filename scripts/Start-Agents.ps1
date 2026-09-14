#Requires -Version 5.1
[CmdletBinding()]
param([string]$Config = (Join-Path $env:LOCALAPPDATA 'EnigmaAgents\config.json'), [switch]$Doctor)
. (Join-Path $PSScriptRoot 'Resolve-StartupPaths.ps1')
$process = $null
$lock = $null
$started = $false
$exitCode = 1
$stage = 'configuration-path'
$logPath = $null
$processRecordPath = $null
$processRecord = $null

function Write-RunnerDiagnostic([string]$EventName, [string]$Detail = '') {
    if (-not $logPath) { return }
    try {
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1048576) {
            Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
        }
        Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + " pid=$PID stage=$stage event=$EventName $Detail")
    } catch { } # A diagnostic write must never obscure the runner's original result.
}

try {
    $Config = Assert-PrivatePath $Config
    $privateRoot = Split-Path -Parent $Config
    $logPath = Join-Path $privateRoot 'runner.log'
    Write-RunnerDiagnostic 'starting'
    $stage = 'configuration-read'
    $settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    $runtime = Get-Content -LiteralPath (Join-Path $privateRoot 'runtime.json') -Raw | ConvertFrom-Json
    $encrypted = Get-Content -LiteralPath (Join-Path $privateRoot 'secrets.json') -Raw | ConvertFrom-Json
    $stateDir = Assert-PrivatePath $settings.stateDir
    if (-not $Doctor) {
        $stage = 'process-lock'
        try { $lock = [IO.File]::Open((Join-Path $stateDir 'runner.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] { Write-Host 'Enigma is already running or its state directory is unavailable.'; exit 0 }
        $processRecordPath = Assert-PrivatePath (Join-Path $privateRoot 'runner-process.json')
        if (Test-Path -LiteralPath $processRecordPath) {
            $recorded = Get-Content -LiteralPath $processRecordPath -Raw | ConvertFrom-Json
            if ($recorded.version -ne 1 -or [string]$recorded.processId -notmatch '^[1-9][0-9]{0,9}$' -or
                [string]$recorded.creationUtcTicks -notmatch '^[0-9]{1,19}$') { throw 'Existing runner identity is invalid.' }
            $existingChild = Get-Process -Id ([int]$recorded.processId) -ErrorAction SilentlyContinue
            if ($existingChild) {
                try {
                    if ($existingChild.StartTime.ToUniversalTime().Ticks -eq [long]$recorded.creationUtcTicks) {
                        throw 'A recorded runner is still active. Use Restart-Agents.ps1 to verify and stop it.'
                    }
                } finally { $existingChild.Dispose() }
            }
        }
    }
    $stage = 'process-configuration'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $runtime.nodeCommand
    $start.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $arguments = @((Join-Path $start.WorkingDirectory 'src\main.mjs'))
    if ($Doctor) { $arguments += 'doctor' }
    $arguments += @('--config', $Config)
    $start.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Prevent inherited API credentials from becoming a billing fallback.
    foreach ($name in @('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ADMIN_KEY')) { $start.EnvironmentVariables.Remove($name) }
    $stage = 'credential-decryption'
    foreach ($bot in $settings.bots) {
        foreach ($name in @($bot.botTokenEnv, $bot.appTokenEnv)) {
            if ($name -cnotmatch '^ENIGMA_[A-Z0-9_]+_(BOT|APP)_TOKEN$') { throw 'Unexpected token environment name.' }
            $secure = ConvertTo-SecureString $encrypted.$name
            $pointer = [IntPtr]::Zero
            try {
                $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
                $start.EnvironmentVariables[$name] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            } finally {
                if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
                $secure.Dispose()
            }
        }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $stage = 'process-start'
    [void]$process.Start()
    $started = $true
    if (-not $Doctor) {
        $processRecord = @{
            version = 1
            processId = $process.Id
            creationUtcTicks = $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
            nodePath = Get-EnigmaPhysicalPath $start.FileName
            mainPath = Get-EnigmaPhysicalPath (Join-Path $start.WorkingDirectory 'src\main.mjs')
            configPath = Get-EnigmaPhysicalPath $Config
        }
        Write-PrivateJson $processRecordPath $processRecord
    }
    Write-RunnerDiagnostic 'child-started' ('childPid=' + $process.Id)
    # Drain both streams concurrently without retaining prompts, RPC payloads, or secrets.
    $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $start.EnvironmentVariables.Clear()
    $stage = 'process-wait'
    if (-not $Doctor) { Write-Host 'Enigma is running. Use Slack status to check work. Ctrl+C stops this foreground runner.' }
    while (-not $process.WaitForExit(250)) { }
    [void]$stdout.GetAwaiter().GetResult()
    [void]$stderr.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    Write-RunnerDiagnostic 'child-exited' ('exitCode=' + $exitCode)
    if ($Doctor) {
        if ($exitCode -eq 0) { Write-Host 'Doctor passed: configuration and account checks succeeded.' -ForegroundColor Green }
        else { Write-Host 'Doctor failed. Check configuration, Slack tokens, Codex ChatGPT login, and required model access. See docs/SETUP.md.' -ForegroundColor Yellow }
    }
} catch {
    # Never record exception messages, script source, RPC payloads, or credentials.
    $failure = $_.Exception.GetBaseException()
    Write-RunnerDiagnostic 'failed' ('type=' + $failure.GetType().FullName + ' hresult=' + $failure.HResult)
    Write-Host "Enigma could not start at stage '$stage'. Check the safe diagnostics in runner.log and docs/SETUP.md." -ForegroundColor Red
} finally {
    if ($process) {
        if ($started -and -not $process.HasExited) {
            # Terminate this known child tree only; never search for unrelated Node/Codex processes.
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F *> $null
        }
        if ($processRecord -and $process.HasExited -and (Test-Path -LiteralPath $processRecordPath)) {
            try {
                $recorded = Get-Content -LiteralPath $processRecordPath -Raw | ConvertFrom-Json
                if ($recorded.processId -eq $processRecord.processId -and $recorded.creationUtcTicks -eq $processRecord.creationUtcTicks) {
                    Remove-Item -LiteralPath $processRecordPath -Force
                }
            } catch { } # Preserve unreadable or replaced records for inspection.
        }
        $process.Dispose()
    }
    if ($lock) { $lock.Dispose() }
}
exit $exitCode
