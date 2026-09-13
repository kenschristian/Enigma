Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-IdentifierList([string]$Label, [string]$Pattern) {
    while ($true) {
        $values = @((Read-Host $Label).Split(',') | ForEach-Object { $_.Trim() } | Select-Object -Unique)
        if ($values.Count -gt 0 -and @($values | Where-Object { $_ -cnotmatch $Pattern }).Count -eq 0) { return ,$values }
        Write-Host 'Use exact Slack IDs, separated by commas. Names and workspace URLs are not IDs.' -ForegroundColor Yellow
    }
}

function Read-SlackWorkspaceId {
    while ($true) {
        $values = Read-IdentifierList 'Workspace ID (T...)' '^T[A-Z0-9]+$'
        if ($values.Count -eq 1) { return [string]$values[0] }
        Write-Host 'Configure exactly one Slack workspace.' -ForegroundColor Yellow
    }
}

function Get-EnigmaHome {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable. Run as your signed-in Windows user.' }
    return Join-Path $env:LOCALAPPDATA 'EnigmaAgents'
}

function Assert-PrivatePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $local = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
    if (-not $full.StartsWith($local, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Private configuration and state must stay under LOCALAPPDATA.'
    }
    foreach ($cloud in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
        if ($cloud -and $full.StartsWith(([IO.Path]::GetFullPath($cloud).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Private configuration must not be stored in OneDrive.'
        }
    }
    $current = $full
    while ($current) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Private paths must not use links or junctions.'
        }
        $current = Split-Path -Parent $current
    }
    return $full
}

function Initialize-PrivateDirectory([string]$Path) {
    $full = Assert-PrivatePath $Path
    [void][IO.Directory]::CreateDirectory($full)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    # Set-Acl's provider can request audit/SACL privileges when reapplying an ACL.
    # These APIs persist only the owner and DACL sections modified above, without
    # touching the audit policy or requiring SeSecurityPrivilege.
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        [IO.Directory]::SetAccessControl($full, $acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl((New-Object IO.DirectoryInfo($full)), $acl)
    }
    return $full
}

function Write-PrivateJson([string]$Path, $Value) {
    $full = Assert-PrivatePath $Path
    $temporary = $full + '.new'
    $json = $Value | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $full -Force
}

function Find-EnigmaExecutable([string]$Name, [string[]]$Candidates) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return [IO.Path]::GetFullPath($candidate) }
    }
    throw "$Name was not found. Install or locate the existing runtime, then rerun setup."
}

function ConvertTo-WindowsArgument([string]$Value) {
    # CommandLineToArgvW quoting, including trailing slashes and embedded quotes.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-EnigmaTaskName {
    return 'EnigmaAgents-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
