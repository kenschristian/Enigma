#Requires -Version 5.1
[CmdletBinding()]
param([string]$Config = (Join-Path $env:LOCALAPPDATA 'EnigmaAgents\config.json'))
. (Join-Path $PSScriptRoot 'Resolve-StartupPaths.ps1')
$Config = Resolve-EnigmaStartupPaths $Config
& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $Config -Doctor
if ($LASTEXITCODE -ne 0) { throw 'Doctor must pass before startup can be installed. See docs/SETUP.md.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$scriptPath = Join-Path $PSScriptRoot 'Start-Agents.ps1'
$argsText = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (ConvertTo-WindowsArgument $scriptPath) + ' -Config ' + (ConvertTo-WindowsArgument $Config)
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $argsText -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Enigma Slack bridge. Runs as the signed-in user; three failure retries. No service password.'
$taskName = Get-EnigmaTaskName
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-Host "Installed $taskName. It starts hidden after your next Windows sign-in."
Write-Host "Startup configuration: $Config"
Write-Host 'To run now, use .\scripts\Restart-Agents.ps1. Your computer must remain awake and online.'
