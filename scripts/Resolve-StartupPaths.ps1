#Requires -Version 5.1
# Helpers only: dot-source this file, then call Resolve-EnigmaStartupPaths explicitly.
. (Join-Path $PSScriptRoot 'Common.ps1')

function Get-EnigmaPhysicalPath([string]$Path) {
    if (-not ('Enigma.StartupPaths' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Enigma {
    public static class StartupPaths {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(string name, uint access, uint share,
            IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,
            StringBuilder path, uint size, uint flags);
    }
}
'@
    }
    # Open the existing file/directory without reading contents. A handle resolves
    # MSIX AppData redirection that Resolve-Path and string normalization cannot see.
    $full = [IO.Path]::GetFullPath($Path)
    $handle = [Enigma.StartupPaths]::CreateFile($full, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    try {
        if ($handle.IsInvalid) { throw 'A configured startup path is missing or inaccessible. Rerun setup from the original Windows account.' }
        $buffer = New-Object Text.StringBuilder 32768
        $length = [Enigma.StartupPaths]::GetFinalPathNameByHandle($handle, $buffer, $buffer.Capacity, 0)
        if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Could not resolve a configured startup path.' }
        $resolved = $buffer.ToString()
        if ($resolved.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { return '\\' + $resolved.Substring(8) }
        if ($resolved.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { return $resolved.Substring(4) }
        return $resolved
    } finally { $handle.Dispose() }
}

function Resolve-EnigmaStartupPaths([string]$Config) {
    $logicalConfig = Assert-PrivatePath $Config
    $physicalConfig = Assert-PrivatePath (Get-EnigmaPhysicalPath $logicalConfig)
    $privateRoot = Split-Path -Parent $physicalConfig
    $runtimePath = Join-Path $privateRoot 'runtime.json'
    $settings = Get-Content -LiteralPath $physicalConfig -Raw | ConvertFrom-Json
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json

    # Resolve every dependency before writing metadata. No files are moved/copied;
    # existing state, Git worktrees, and DPAPI ciphertext stay exactly where they are.
    $settings.repoPath = Get-EnigmaPhysicalPath $settings.repoPath
    foreach ($name in @('stateDir', 'worktreesRoot')) {
        [void](Assert-PrivatePath $settings.$name)
        $settings.$name = Assert-PrivatePath (Get-EnigmaPhysicalPath $settings.$name)
    }
    $settings.codexCommand = Get-EnigmaPhysicalPath $settings.codexCommand
    $runtime.nodeCommand = Get-EnigmaPhysicalPath $runtime.nodeCommand
    if ($settings.PSObject.Properties['projects']) {
        foreach ($project in $settings.projects) { $project.repoPath = Get-EnigmaPhysicalPath $project.repoPath }
    }
    Write-PrivateJson $runtimePath $runtime
    Write-PrivateJson $physicalConfig $settings
    return $physicalConfig
}
