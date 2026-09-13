#Requires -Version 5.1
[CmdletBinding()]
param([string]$RepoPath = (Split-Path -Parent $PSScriptRoot), [switch]$FourBots)
. (Join-Path $PSScriptRoot 'Common.ps1')

function Read-IdentifierList([string]$Label, [string]$Pattern) {
    while ($true) {
        $values = @((Read-Host $Label).Split(',') | ForEach-Object { $_.Trim() } | Select-Object -Unique)
        if ($values.Count -gt 0 -and @($values | Where-Object { $_ -cnotmatch $Pattern }).Count -eq 0) { return ,$values }
        Write-Host 'Use exact Slack IDs, separated by commas. Names and workspace URLs are not IDs.' -ForegroundColor Yellow
    }
}

function Read-EncryptedToken([string]$Label, [string]$Prefix) {
    while ($true) {
        $secure = Read-Host $Label -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ($value.StartsWith($Prefix) -and $value -notmatch '\s' -and $value.Length -gt $Prefix.Length) {
                return ConvertFrom-SecureString $secure
            }
            Write-Host "That token must start with $Prefix and contain no spaces. Try again." -ForegroundColor Yellow
        } finally {
            $value = $null
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            $secure.Dispose()
        }
    }
}

Write-Host "Enigma setup | Your Windows account | Existing ChatGPT sign-in" -ForegroundColor Cyan
Write-Host 'Keep this window private. Paste Slack tokens only into the masked prompts below.'
Write-Host 'Use docs/SETUP.md to create the Slack app in enigma777.slack.com first.'
$privateRoot = Initialize-PrivateDirectory (Get-EnigmaHome)
$configPath = Join-Path $privateRoot 'config.json'
if (Test-Path -LiteralPath $configPath) {
    if ((Read-Host 'Configuration already exists. Type REPLACE to re-enter its IDs and tokens, or Enter to cancel') -cne 'REPLACE') { return }
}
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path
& git -C $RepoPath rev-parse --verify HEAD *> $null
if ($LASTEXITCODE -ne 0) { throw 'The target repository needs an initial Git commit before setup.' }
$node = Find-EnigmaExecutable 'node.exe' @((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
$nodeVersion = & $node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
$codexCandidates = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object FullName)
$codex = Find-EnigmaExecutable 'codex.exe' $codexCandidates
$team = @(Read-IdentifierList 'Workspace ID (T...)' '^T[A-Z0-9]+$')
if ($team.Count -ne 1) { throw 'Configure exactly one Slack workspace.' }
$users = Read-IdentifierList 'Your allowed Slack member IDs (U... or W...), comma-separated' '^[UW][A-Z0-9]+$'
$channels = Read-IdentifierList 'Allowed channel IDs (C... or G...), comma-separated' '^[CG][A-Z0-9]+$'
$roles = @([pscustomobject]@{ key = 'atlas'; role = 'atlas' })
if ($FourBots) {
    $roles += @([pscustomobject]@{ key = 'nova'; role = 'frontend' }, [pscustomobject]@{ key = 'forge'; role = 'backend' }, [pscustomobject]@{ key = 'bridge'; role = 'api' })
}
$bots = @()
$secrets = [ordered]@{}
foreach ($role in $roles) {
    Write-Host "Enter the tokens for the $($role.key) Slack app." -ForegroundColor Cyan
    $prefix = 'ENIGMA_' + $role.key.ToUpperInvariant()
    $botEnv = $prefix + '_BOT_TOKEN'
    $appEnv = $prefix + '_APP_TOKEN'
    $secrets[$botEnv] = Read-EncryptedToken 'Bot User OAuth Token (xoxb-...)' 'xoxb-'
    $secrets[$appEnv] = Read-EncryptedToken 'App-Level Token with connections:write (xapp-...)' 'xapp-'
    $bots += @{ key = $role.key; role = $role.role; botTokenEnv = $botEnv; appTokenEnv = $appEnv }
}
$stateDir = Initialize-PrivateDirectory (Join-Path $privateRoot 'state')
$worktreesRoot = Initialize-PrivateDirectory (Join-Path $privateRoot 'worktrees')
$config = [ordered]@{ version = 1; repoPath = $RepoPath; stateDir = $stateDir; worktreesRoot = $worktreesRoot; codexCommand = $codex; allowedTeamId = $team[0]; allowedUserIds = @($users); allowedChannelIds = @($channels); maxConcurrent = 1; taskTimeoutMinutes = 45; bots = @($bots) }
Write-PrivateJson (Join-Path $privateRoot 'secrets.json') $secrets
Write-PrivateJson (Join-Path $privateRoot 'runtime.json') @{ nodeCommand = $node }
Write-PrivateJson $configPath $config
Write-Host "Saved private configuration to $configPath"
Write-Host 'Running doctor. No startup task has been registered.'
& (Join-Path $PSScriptRoot 'Start-Agents.ps1') -Config $configPath -Doctor
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Doctor did not pass. If Codex is not signed in, run this command and choose your SAME existing ChatGPT account:' -ForegroundColor Yellow
    Write-Host ('& ' + ("'" + $codex.Replace("'", "''") + "'") + ' login')
    Write-Host 'Then run .\scripts\Start-Agents.ps1 -Doctor again. Do not create API keys or another account.'
    return
}
Write-Host 'Doctor passed. Run .\scripts\Start-Agents.ps1 to test Slack in the foreground.' -ForegroundColor Green
Write-Host 'After that test, run .\scripts\Install-Startup.ps1 to enable hidden startup at your next Windows sign-in.'
