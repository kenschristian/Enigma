#Requires -Version 5.1
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'Common.ps1')
$taskName = Get-EnigmaTaskName
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) { throw 'Run Install-Startup.ps1 after doctor passes, or Start-Agents.ps1 for a foreground session.' }
Stop-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 250
    $task = Get-ScheduledTask -TaskName $taskName
} while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
if ($task.State -eq 'Running') { throw 'The old runner has not stopped. Check Task Scheduler before trying again.' }
Start-ScheduledTask -TaskName $taskName
Write-Host 'Start requested. Check Slack with an @Atlas status message in the allowed channel.'
Write-Host 'Interrupted coding tasks require an explicit resume command. A start request alone does not confirm Slack connectivity.'
