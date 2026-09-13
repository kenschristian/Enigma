#Requires -Version 5.1
[CmdletBinding()]
param([string]$Config = (Join-Path $env:LOCALAPPDATA 'EnigmaAgents\config.json'), [switch]$Doctor)
. (Join-Path $PSScriptRoot 'Common.ps1')
$process = $null
$lock = $null
$started = $false
$exitCode = 1
try {
    $Config = Assert-PrivatePath $Config
    $privateRoot = Split-Path -Parent $Config
    $settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    $runtime = Get-Content -LiteralPath (Join-Path $privateRoot 'runtime.json') -Raw | ConvertFrom-Json
    $encrypted = Get-Content -LiteralPath (Join-Path $privateRoot 'secrets.json') -Raw | ConvertFrom-Json
    $stateDir = Assert-PrivatePath $settings.stateDir
    if (-not $Doctor) {
        try { $lock = [IO.File]::Open((Join-Path $stateDir 'runner.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] { Write-Host 'Enigma is already running or its state directory is unavailable.'; exit 0 }
    }
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
    [void]$process.Start()
    $started = $true
    # Drain both streams concurrently without retaining prompts, RPC payloads, or secrets.
    $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $start.EnvironmentVariables.Clear()
    if (-not $Doctor) { Write-Host 'Enigma is running. Use Slack status to check work. Ctrl+C stops this foreground runner.' }
    while (-not $process.WaitForExit(250)) { }
    $stdout.GetAwaiter().GetResult()
    $stderr.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    if ($Doctor) {
        if ($exitCode -eq 0) { Write-Host 'Doctor passed: configuration and account checks succeeded.' -ForegroundColor Green }
        else { Write-Host 'Doctor failed. Check configuration, Slack tokens, Codex ChatGPT login, and required model access. See docs/SETUP.md.' -ForegroundColor Yellow }
    } else {
        $logPath = Join-Path $privateRoot 'runner.log'
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1048576) {
            Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
        }
        Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' runner stopped; exit code ' + $exitCode)
    }
} catch {
    Write-Host 'Enigma could not start. Rerun Setup.ps1 under the Windows account that saved the tokens; check docs/SETUP.md.' -ForegroundColor Red
} finally {
    if ($process) {
        if ($started -and -not $process.HasExited) {
            # Terminate this known child tree only; never search for unrelated Node/Codex processes.
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F *> $null
        }
        $process.Dispose()
    }
    if ($lock) { $lock.Dispose() }
}
exit $exitCode
