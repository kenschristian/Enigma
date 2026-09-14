#Requires -Version 5.1
[CmdletBinding()]
param([string]$Config)
. (Join-Path $PSScriptRoot 'Resolve-StartupPaths.ps1')

function ConvertFrom-EnigmaCommandLine([string]$CommandLine) {
    if (-not ('Enigma.RunnerArguments' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Enigma {
    public static class RunnerArguments {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CommandLineToArgvW(string command, out int count);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        public static string[] Parse(string command) {
            int count;
            IntPtr memory = CommandLineToArgvW(command, out count);
            if (memory == IntPtr.Zero) throw new InvalidOperationException("Cannot parse process arguments.");
            try {
                var result = new string[count];
                for (int i = 0; i < count; i++)
                    result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
                return result;
            } finally { LocalFree(memory); }
        }
    }
}
'@
    }
    return ,([Enigma.RunnerArguments]::Parse($CommandLine))
}

function Test-EnigmaSamePhysicalPath([string]$First, [string]$Second) {
    return [string]::Equals((Get-EnigmaPhysicalPath $First), (Get-EnigmaPhysicalPath $Second), [StringComparison]::OrdinalIgnoreCase)
}

function Get-EnigmaRecordedChild([string]$RecordPath, [string]$NodePath, [string]$MainPath, [string]$ConfigPath) {
    $child = $null
    $descendants = New-Object 'Collections.Generic.List[Diagnostics.Process]'
    try {
        $record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
        if ($record.version -ne 1 -or [string]$record.processId -notmatch '^[1-9][0-9]{0,9}$' -or
            [string]$record.creationUtcTicks -notmatch '^[0-9]{1,19}$' -or
            -not (Test-EnigmaSamePhysicalPath $record.nodePath $NodePath) -or
            -not (Test-EnigmaSamePhysicalPath $record.mainPath $MainPath) -or
            -not (Test-EnigmaSamePhysicalPath $record.configPath $ConfigPath)) { throw 'Invalid process record.' }
        $child = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
        # Without the original root we cannot prove that an earlier partial stop
        # left no descendants. Preserve provenance for explicit local recovery.
        if (-not $child) { throw 'The recorded runner is absent; its process tree cannot be verified.' }
        if ($child) {
            # Hold the original process handle until stopping is complete. Creation
            # ticks come from GetProcessTimes through .NET on both write and read.
            [void]$child.Handle
            if ($child.StartTime.ToUniversalTime().Ticks -ne [long]$record.creationUtcTicks) { throw 'Process identity changed.' }
            $details = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.processId)
            if (-not $details -or -not (Test-EnigmaSamePhysicalPath $details.ExecutablePath $NodePath)) { throw 'Process executable changed.' }
            $arguments = ConvertFrom-EnigmaCommandLine $details.CommandLine
            if ($arguments.Count -ne 4 -or $arguments[2] -cne '--config' -or
                -not (Test-EnigmaSamePhysicalPath $arguments[0] $NodePath) -or
                -not (Test-EnigmaSamePhysicalPath $arguments[1] $MainPath) -or
                -not (Test-EnigmaSamePhysicalPath $arguments[3] $ConfigPath)) { throw 'Process arguments changed.' }
            $parents = New-Object 'Collections.Generic.Queue[Diagnostics.Process]'
            $parents.Enqueue($child)
            $seen = @{ ([string]$child.Id) = $true }
            while ($parents.Count -gt 0) {
                $parent = $parents.Dequeue()
                # Query only children of an already verified, pinned process.
                foreach ($candidate in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $parent.Id))) {
                    if ($seen.ContainsKey([string]$candidate.ProcessId)) { throw 'Invalid process ancestry.' }
                    $descendant = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction SilentlyContinue
                    if (-not $descendant) { continue }
                    $descendants.Add($descendant)
                    [void]$descendant.Handle
                    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $descendant.Id)
                    if (-not $current -or $current.ParentProcessId -ne $parent.Id -or
                        $descendant.StartTime.ToUniversalTime().Ticks -lt $parent.StartTime.ToUniversalTime().Ticks) { throw 'Process ancestry changed.' }
                    $seen[[string]$descendant.Id] = $true
                    $parents.Enqueue($descendant)
                }
            }
        }
        return [pscustomobject]@{ Record = $record; Process = $child; Descendants = $descendants }
    } catch {
        foreach ($descendant in $descendants) { $descendant.Dispose() }
        if ($child) { $child.Dispose() }
        throw 'Recorded runner identity could not be verified. No process was stopped; inspect the runner locally before retrying.'
    }
}

function Remove-EnigmaMatchingProcessRecord([string]$RecordPath, $Record) {
    try {
        if (Test-Path -LiteralPath $RecordPath) {
            $current = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
            if ($current.processId -eq $Record.processId -and $current.creationUtcTicks -eq $Record.creationUtcTicks) {
                Remove-Item -LiteralPath $RecordPath -Force
            }
        }
    } catch { } # Preserve unreadable or replaced records for inspection.
}

function Stop-EnigmaRecordedChild($Identity, [string]$RecordPath) {
    $treeFailed = $false
    if ($Identity.Process -and -not $Identity.Process.HasExited) {
        # Only the verified process tree; the pinned handle prevents PID reuse.
        & "$env:SystemRoot\System32\taskkill.exe" /PID $Identity.Record.processId /T /F *> $null
        $treeFailed = $LASTEXITCODE -ne 0
    }
    # Scheduler termination or a concurrent Node exit can orphan these children.
    # Use their pinned handles, never rediscover a process by name or a stale PID.
    foreach ($descendant in $Identity.Descendants) {
        if (-not $descendant.HasExited) { $descendant.Kill() }
    }
    $remaining = @($Identity.Descendants)
    if ($Identity.Process) { $remaining += $Identity.Process }
    foreach ($process in $remaining) {
        if (-not $process.WaitForExit(5000)) { throw 'A verified runner process did not stop. Inspect the remaining process locally before retrying.' }
    }
    if ($treeFailed) { throw 'Runner tree termination reported a failure. Inspect the remaining processes locally before retrying.' }
    Remove-EnigmaMatchingProcessRecord $RecordPath $Identity.Record
}

function Get-EnigmaTaskArgument([string[]]$Arguments, [string]$Name) {
    $found = @()
    for ($index = 1; $index -lt $Arguments.Count; $index++) {
        if ($Arguments[$index] -ieq $Name) {
            if ($index + 1 -ge $Arguments.Count) { throw 'Invalid scheduled runner arguments.' }
            $found += $Arguments[$index + 1]
        }
    }
    if ($found.Count -ne 1) { throw 'Invalid scheduled runner arguments.' }
    return $found[0]
}

function Invoke-EnigmaRestart([string]$ConfigPath) {
    $taskName = Get-EnigmaTaskName
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { throw 'Run Install-Startup.ps1 after doctor passes, or Start-Agents.ps1 for a foreground session.' }
    if (@($task.Actions).Count -ne 1) { throw 'The scheduled runner action does not match this installation.' }
    $action = $task.Actions[0]
    $arguments = ConvertFrom-EnigmaCommandLine ('powershell.exe ' + $action.Arguments)
    if (-not (Test-EnigmaSamePhysicalPath $action.Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe") -or
        -not (Test-EnigmaSamePhysicalPath (Get-EnigmaTaskArgument $arguments '-File') (Join-Path $PSScriptRoot 'Start-Agents.ps1'))) {
        throw 'The scheduled runner action does not match this installation.'
    }
    $scheduledConfig = Assert-PrivatePath (Get-EnigmaPhysicalPath (Get-EnigmaTaskArgument $arguments '-Config'))
    if ($ConfigPath -and -not (Test-EnigmaSamePhysicalPath $ConfigPath $scheduledConfig)) { throw 'The requested configuration differs from the scheduled runner.' }
    $privateRoot = Split-Path -Parent $scheduledConfig
    $recordPath = Assert-PrivatePath (Join-Path $privateRoot 'runner-process.json')
    $runtime = Get-Content -LiteralPath (Join-Path $privateRoot 'runtime.json') -Raw | ConvertFrom-Json
    $identity = $null
    try {
    if (Test-Path -LiteralPath $recordPath) {
        $identity = Get-EnigmaRecordedChild $recordPath $runtime.nodeCommand (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\main.mjs') $scheduledConfig
    } elseif ($task.State -eq 'Running') {
        throw 'The active runner has no verified process record. It was left running; stop the legacy runner after verifying its identity locally, then retry.'
    }
    try {
        if ($identity) { Stop-EnigmaRecordedChild $identity $recordPath }
    } finally {
        # Cancel scheduler retries even when cleanup fails after Node has exited.
        # The original cleanup error still prevents Start-ScheduledTask below.
        Stop-ScheduledTask -TaskName $taskName
    }
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $taskName
    } while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
    if ($task.State -eq 'Running') { throw 'The old runner has not stopped. Check Task Scheduler before trying again.' }
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(15)
    $runningSince = $null
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $taskName
        if ($task.State -eq 'Running') {
            if (-not $runningSince) { $runningSince = Get-Date }
            if (((Get-Date) - $runningSince).TotalSeconds -ge 3) { break }
        } else {
            if ($runningSince) {
                $result = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
                throw "Enigma exited during startup (task result $result). Check runner.log beside the configured startup file."
            }
        }
    } while ((Get-Date) -lt $deadline)
    if (-not $runningSince -or $task.State -ne 'Running') {
        $result = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
        throw "Enigma did not remain running (task result $result). Check runner.log beside the configured startup file."
    }
    Write-Host 'The scheduled runner is active. Check Slack with an @Atlas status message in the allowed channel.'
    Write-Host 'Interrupted coding tasks require an explicit resume command. A start request alone does not confirm Slack connectivity.'
    } finally {
        if ($identity) { foreach ($descendant in $identity.Descendants) { $descendant.Dispose() } }
        if ($identity -and $identity.Process) { $identity.Process.Dispose() }
    }
}

# Dot-sourcing exposes the verifier for isolated process tests without scheduler activity.
if ($MyInvocation.InvocationName -ne '.') { Invoke-EnigmaRestart $Config }
