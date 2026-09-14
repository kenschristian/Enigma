# Operations

Run commands from the repository in your normal signed-in Windows PowerShell session.

| Action | Command |
| --- | --- |
| Check configuration/account | `.\scripts\Start-Agents.ps1 -Doctor` |
| Run in foreground | `.\scripts\Start-Agents.ps1` |
| Register startup | `.\scripts\Install-Startup.ps1` |
| Restart registered runner | `.\scripts\Restart-Agents.ps1` |
| Stop and remove startup | `.\scripts\Remove-Startup.ps1` |
| Check script syntax and credential helpers | `.\scripts\Test-Scripts.ps1` |
| Test startup paths and safe diagnostics with synthetic fixtures | `.\scripts\Test-Startup.ps1` |

The startup task name is `EnigmaAgents-` followed by your Windows SID. You can inspect it in **Task Scheduler**. Removal stops the registered task and preserves configuration, task history, and worktrees. A separately started foreground runner must be stopped in its own console. Startup registration requires no administrator elevation, although managed Windows policies can prohibit task registration; use the foreground runner in that case.

## Restart and recovery

The wrapper holds an exclusive lock on the configured state directory. A second runner using that directory exits without starting another bridge. Task Scheduler also uses `IgnoreNew`. Restarting may interrupt active coding work; use `@Atlas status` and `@Atlas resume <task-id>` to continue deliberately. Existing worktrees are preserved. Do not delete or reset a worktree to resolve an interruption.

The wrapper records nonsecret process identity in `runner-process.json` beside the private configuration. Restart verifies the recorded process and captures its child processes before stopping them, then starts a replacement only after cleanup succeeds. A running legacy version without a record needs a one-time locally verified upgrade. An absent or mismatched recorded process, or incomplete cleanup, requires local inspection; do not delete the record or stop processes by name to bypass that check. Ordinary Windows reboot/logon startup can replace a stale record while retaining saved tasks and credentials.

Only events received and persisted locally can be recovered. There is no promise to replay messages sent while the computer is asleep, offline, signed out, or stopped. Resend the request when connected if it was never acknowledged. A task accepted before a crash may have partially completed changes; review those before resuming.

The computer must be awake, online, and signed in for the startup runner to work. If three restart attempts fail, fix the underlying issue and run `Restart-Agents.ps1`. That script checks that the scheduled runner remains active; a successful Slack response confirms connectivity.

## Troubleshooting

**Doctor fails:** Check that the repository has its initial commit, Node is version 24+, Codex's absolute path still exists, your normal Windows account is signed into Codex with ChatGPT, the requested model/reasoning combination is accessible, the Slack workspace ID matches the installed app, and both Slack tokens are current. The wrapper deliberately prints a generic diagnostic result and discards process output to avoid logging credentials or raw RPC data.

**No Slack reply:** Confirm doctor passes, the process is running, the bot is invited to the channel, Socket Mode is enabled, the app token has `connections:write`, and you used a real `@Atlas` mention. Check the exact user/channel/workspace IDs in the private configuration. Ordinary messages, DMs, bots, and unauthorized IDs are not accepted by the supplied manifest/configuration.

**A request needs elevated access:** The bridge does not approve it. Review the request locally and decide how to proceed through an interactive Codex session. Do not weaken the bridge sandbox to make an unattended task pass.

**Private worktree permissions:** Windows coding sessions use the installed Codex beta permission-profile contract: the verified conversation worktree is writable, its configured repository's dedicated `.git` directory is readable, and Git metadata, `.codex`, and `.agents` remain protected from writes. Unrelated private folders and network access are not granted. The client verifies the effective profile before starting work and stops with `CODEX_PROFILE` if the runtime cannot confirm it. The configured repository must be a regular clone with its own `.git` directory. Git operations that change protected metadata still need an interactive approval; this connection never approves them automatically.

**PowerShell starts in the wrong folder:** The installed Windows PowerShell provider cannot enter these private package folders reliably. Coding instructions use `C:\Windows\System32\cmd.exe`, `login:false`, an explicit work directory, and `git -C` with the absolute worktree path. Child environment names are normalized to prevent duplicate `PATH`/`Path` entries. These workarounds were checked with the installed Codex runtime; do not broaden folder access to work around a shell error.

**Tokens rotated or app reinstalled:** Stop the runner, then rerun `Setup.ps1` (add `-FourBots` if appropriate). Enter every active token pair again. Doctor must pass before restarting. Never edit plaintext tokens into `config.json`.

**Codex/Node moved after an update:** Rerun setup to refresh executable paths. If PATH points to an old Node version, update PATH to the installed Node 24+ executable before running setup. Startup points to this checkout's scripts; reinstall startup if you move the repository.

**Different Windows user / access denied:** Run under the user who completed setup. Encrypted tokens cannot be copied to another account as a working configuration. Setup uses a private directory ACL, so backups and account migration require deliberate handling.

**Need logs:** `runner.log` beside the startup configuration contains timestamps, process IDs, fixed startup stages, exit codes, and exception type/HResult codes. At roughly 1 MB, it rotates to one `.1` file. Exception messages, Slack prompts, replies, credentials, and raw process/RPC output are not written there. Task state contains private prompts/results and must remain outside Git and cloud-synced folders.

**Starts in Codex but immediately stops in Task Scheduler:** A packaged Windows app can redirect `%LOCALAPPDATA%` writes into its own package directory. Startup installation resolves the existing physical configuration, state, worktree, Node, Codex, and project paths before doctor and registration. It updates only nonsecret path metadata; credentials and worktrees stay in place. The installer prints the physical startup configuration path, which is also recorded in the task action. Use that exact path with `Start-Agents.ps1 -Config '<path>' -Doctor` when running from a normal PowerShell session. Microsoft describes this [MSIX AppData redirection](https://learn.microsoft.com/en-us/windows/msix/packaging-tool/know-your-installer). Do not delete a package's data or uninstall the hosting package while relying on private state stored there.

## Validation boundaries

Parser and helper checks validate PowerShell syntax, Windows command argument quoting, rejection of non-private paths, and a synthetic DPAPI round trip. They do not install a scheduled task or authenticate to Slack. Live validation needs the real allowlisted IDs/tokens and a successful Slack request. Do not describe a local build, a registered task, or a pushed commit as a deployed or working Slack integration without that check.
