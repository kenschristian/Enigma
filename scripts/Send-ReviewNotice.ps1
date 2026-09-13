#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Payload,
    [string]$Config = (Join-Path $env:LOCALAPPDATA 'EnigmaAgents\config.json'),
    [string]$Channel
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$process = $null
$exitCode = 1
try {
    $Config = Assert-PrivatePath $Config
    $Payload = Assert-PrivatePath $Payload
    $runtimePath = Assert-PrivatePath (Join-Path (Split-Path -Parent $Config) 'runtime.json')
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($runtime.nodeCommand) -or -not (Test-Path -LiteralPath $runtime.nodeCommand -PathType Leaf)) {
        throw 'The configured Node runtime is unavailable.'
    }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $runtime.nodeCommand
    $start.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $arguments = @((Join-Path $start.WorkingDirectory 'src\review-notices.mjs'), '--config', $Config, '--payload', $Payload)
    if ($Channel) { $arguments += @('--channel', $Channel) }
    $start.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Notices use the runner's durable outbox. No token decryption is needed.
    foreach ($name in @($start.EnvironmentVariables.Keys)) {
        if ($name -match '^ENIGMA_.*TOKEN$|^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_ADMIN_KEY|GH_TOKEN|GITHUB_TOKEN)$') {
            $start.EnvironmentVariables.Remove($name)
        }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    if ($output) { [Console]::Out.Write($output) }
    if ($errors) { [Console]::Error.Write($errors) }
} catch {
    [Console]::Error.WriteLine('{"status":"error","message":"Review notice could not be queued; check private payload, configuration and runtime paths."}')
} finally {
    if ($process) { $process.Dispose() }
}
exit $exitCode
