#Requires -Version 5.1
[CmdletBinding()]
param()
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
Write-Host 'PASS: PowerShell parser, argument quoting, private-path rejection, and current-user DPAPI round trip.'
