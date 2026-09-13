#Requires -Version 5.1
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'Common.ps1')
$taskName = Get-EnigmaTaskName
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Enigma startup removed. Private configuration, history, and worktrees were preserved.'
} else { Write-Host 'Enigma startup is not installed for this user.' }
