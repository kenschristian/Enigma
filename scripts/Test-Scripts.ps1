#Requires -Version 5.1
[CmdletBinding()]
param([switch]$PrivateDirectoryAcl)
$ErrorActionPreference = 'Stop'
$failureCount = 0
Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | ForEach-Object {
    $parseTokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$parseTokens, [ref]$parseErrors)
    foreach ($problem in $parseErrors) { Write-Host ($_.Name + ': ' + $problem.Message); $failureCount++ }
}
if ($failureCount) { throw "$failureCount PowerShell parse failures." }
. (Join-Path $PSScriptRoot 'Common.ps1')
# Exercise the real input helpers with a finite synthetic input queue, never live credentials.
$script:IdentifierInputs = New-Object 'Collections.Generic.Queue[string]'
function Read-Host {
    param([string]$Prompt)
    if ($script:IdentifierInputs.Count -eq 0) { throw 'Input helper unexpectedly requested another answer.' }
    return $script:IdentifierInputs.Dequeue()
}
try {
    foreach ($answer in @('enigma777.slack.com', 'T111,T222', ' T333 ')) { $script:IdentifierInputs.Enqueue($answer) }
    $workspace = Read-SlackWorkspaceId
    if ($workspace -isnot [string] -or $workspace -cne 'T333') { throw 'Workspace input must yield exactly one scalar ID.' }
    $script:IdentifierInputs.Enqueue(' U111 ')
    $members = Read-IdentifierList 'Members' '^[UW][A-Z0-9]+$'
    if ($members -isnot [array] -or $members.Count -ne 1 -or $members[0] -isnot [string]) { throw 'One member must remain a flat string array.' }
    $script:IdentifierInputs.Enqueue('C111, G222, C111')
    $channels = Read-IdentifierList 'Channels' '^[CG][A-Z0-9]+$'
    if ($channels.Count -ne 2 -or $channels[0] -cne 'C111' -or $channels[1] -cne 'G222') { throw 'Channel list must trim and deduplicate strings.' }
    $encoded = @{ allowedTeamId = $workspace; allowedUserIds = @($members); allowedChannelIds = @($channels) } | ConvertTo-Json -Compress
    $decoded = $encoded | ConvertFrom-Json
    if ($decoded.allowedTeamId -isnot [string] -or $decoded.allowedUserIds[0] -isnot [string] -or $decoded.allowedChannelIds[0] -isnot [string]) { throw 'Slack IDs changed shape during configuration serialization.' }
} finally { Remove-Item Function:\Read-Host }
if ((ConvertTo-WindowsArgument 'C:\folder name\') -cne '"C:\folder name\\"') { throw 'Trailing-backslash quoting failed.' }
if ((ConvertTo-WindowsArgument 'one"two') -cne '"one\"two"') { throw 'Embedded-quote quoting failed.' }
try { Assert-PrivatePath 'C:\outside\config.json'; throw 'Expected rejection.' } catch { if ($_.Exception.Message -eq 'Expected rejection.') { throw } }
$secret = ConvertTo-SecureString 'xoxb-synthetic-test-value' -AsPlainText -Force
$encrypted = ConvertFrom-SecureString $secret
$roundTrip = ConvertTo-SecureString $encrypted
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundTrip)
try {
    if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -cne 'xoxb-synthetic-test-value') { throw 'DPAPI round trip failed.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secret.Dispose()
    $roundTrip.Dispose()
}
if ($PrivateDirectoryAcl) {
    # Opt-in filesystem integration test: only a fresh, named directory and its
    # synthetic file are touched. Existing configuration and credentials are never read.
    $testPath = Join-Path (Get-EnigmaHome) ('acl-test-' + [guid]::NewGuid().ToString('N'))
    $testPath = Assert-PrivatePath $testPath
    $testFile = Join-Path $testPath 'synthetic.txt'
    try {
        [void](Initialize-PrivateDirectory $testPath)
        [IO.File]::WriteAllText($testFile, 'Synthetic ACL regression fixture')
        # The regression occurs when setup secures a directory that already exists.
        [void](Initialize-PrivateDirectory $testPath)
        [void](Initialize-PrivateDirectory $testPath)
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        foreach ($item in @($testPath, $testFile)) {
            $actual = Get-Acl -LiteralPath $item
            if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid) { throw 'Private fixture owner changed.' }
            $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $currentSid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') {
                throw 'Private fixture must grant FullControl only to the current user.'
            }
        }
        if (-not (Get-Acl -LiteralPath $testPath).AreAccessRulesProtected) { throw 'Private directory unexpectedly inherits permissions.' }
        if ([IO.File]::ReadAllText($testFile) -cne 'Synthetic ACL regression fixture') { throw 'ACL reapplication changed existing content.' }
        Write-Host 'PASS: fresh and existing private directory ACLs, current-user owner, protected DACL, inherited child access, and preserved contents.'
    } finally {
        # No recursive deletion: remove only this test's known file and empty directory.
        if (Test-Path -LiteralPath $testFile) { Remove-Item -LiteralPath $testFile -Force }
        if (Test-Path -LiteralPath $testPath) { [IO.Directory]::Delete($testPath, $false) }
    }
}
Write-Host 'PASS: PowerShell parser, Slack ID input/serialization, argument quoting, private-path rejection, and current-user DPAPI round trip.'
