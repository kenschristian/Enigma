# Windows setup

Allow about 15 minutes for Slack configuration. You need the existing Windows user, Git, Node.js 24 or newer, the installed Codex executable, and permission to install an app in [enigma777.slack.com](https://enigma777.slack.com). You do not need an OpenAI API key or a second provider account.

## 1. Create the Slack app

1. Open [Your Apps](https://api.slack.com/apps) in the browser where you are signed in to Slack. Choose **Create New App**, then **From a manifest**, and choose the **enigma777** workspace.
2. Paste the contents of [`manifests/atlas.json`](../manifests/atlas.json) into the JSON manifest editor. Review and create the app.
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope. Keep this `xapp-` token available in your password manager; enter it only in the local masked setup prompt.
4. Confirm **Socket Mode** is enabled. Under **OAuth & Permissions**, install the app to the workspace and obtain its **Bot User OAuth Token** (`xoxb-`). This is a Slack token, not an OpenAI key.
5. Invite **Atlas** to the channel where you want coding requests. Start with a dedicated private channel. The manifest requests only `app_mentions:read` and `chat:write`, and subscribes to `app_mention`. It does not read channel history or direct messages.

Slack documents [manifest configuration](https://docs.slack.dev/reference/app-manifest/) and [Socket Mode app-level tokens](https://docs.slack.dev/apis/events-api/using-socket-mode/). Socket Mode delivers events over an outbound connection; this setup does not require a public webhook server.

## 2. Collect IDs

The workspace URL alone is insufficient. Open Slack in your browser and find a channel URL like `https://app.slack.com/client/T.../C...`. Save the `T...` workspace ID and the `C...` channel ID. A private channel ID may start with `G`. In Slack, your profile menu has **Copy member ID**; save that `U...` (or `W...`) ID. Setup accepts comma-separated lists for allowed users and channels. Do not add untrusted users.

## 3. Run local setup

Open PowerShell in this repository and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup.ps1
```

The process-only execution policy flag permits these local scripts without changing the machine policy. Read the scripts first if you have downloaded them from another source. Setup locates the existing Node and Codex runtimes, checks the repository has a commit, asks for the IDs, then prompts for the two Slack tokens using masked input. Never paste tokens into Slack, this conversation, a command argument, or a repository file.

Setup writes the following under `%LOCALAPPDATA%\EnigmaAgents` with access restricted to the current Windows user:

| Location | Purpose |
| --- | --- |
| `config.json` | Repository, allowlisted Slack IDs, bot mappings and limits |
| `secrets.json` | Windows DPAPI encrypted Slack tokens |
| `runtime.json` | Absolute path to Node.js |
| `state\` | Private durable task state and process lock |
| `worktrees\` | Isolated coding worktrees |
| `runner.log` | Exit timestamps and codes only; bounded rotation |

Windows DPAPI binds the encrypted credentials to this user on this computer. Processes running as this user can access them; disk encryption is not a sandbox boundary. They must be entered again after moving to a different Windows account or machine.

If Windows blocks a later `.\scripts\...` command because script execution is disabled, run it with the same process-only prefix, for example `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Agents.ps1 -Doctor`. Do not change the machine execution policy.

Setup runs the application doctor. It does not register startup or begin accepting Slack coding requests. If doctor fails, correct the configuration or account problem first.

The existing host Codex installation was confirmed signed in with ChatGPT during development. A restricted shell may not see those credentials. If doctor in your normal Windows session reports a missing login, run the installed Codex executable with `login` and sign in to your **same existing ChatGPT account**. For example, when Codex is on PATH:

```powershell
codex login
.\scripts\Start-Agents.ps1 -Doctor
```

Setup prints the full executable command if needed. Codex supports [ChatGPT account sign-in](https://learn.chatgpt.com/docs/auth). Enigma requires that authentication mode and the configured model/reasoning access; it must not silently switch to API billing or another model. A successful doctor is a prerequisite, not proof of end-to-end Slack task completion.

## 4. Verify in the foreground

```powershell
.\scripts\Start-Agents.ps1
```

In the allowed channel, send `@Atlas help` using a real mention, then `@Atlas status`. Ask for a small read-only repository review and verify a response in its Slack thread. Try an unauthorized channel/user only if you control that account: no task should be accepted. Use **Ctrl+C** to stop the foreground process before enabling background startup.

## 5. Enable startup after verification

```powershell
.\scripts\Install-Startup.ps1
.\scripts\Restart-Agents.ps1
```

Installation reruns doctor, then registers a hidden Scheduled Task for the current user's logon with limited privileges. It does not collect a Windows password or install a system service. It allows three failure restarts, one minute apart. After a reboot it starts **when you sign in**, not while Windows is waiting at the login screen. Check `@Atlas status` to confirm the connection.

## Optional: four separate Slack identities

Create three more Slack apps from `nova.json`, `forge.json`, and `bridge.json`, following the same steps and inviting each app to the allowed channel. Each app has its own bot token and app-level token. Stop the runner, then rerun:

```powershell
.\scripts\Setup.ps1 -FourBots
```

This replaces the active bot configuration and asks for all four pairs of tokens. Reinstall startup after doctor passes. Direct mentions route to that identity; the single Atlas app already supports `nova:`, `forge:`, and `bridge:` prefixes, so four apps are optional. All work shares the same configured concurrency limit (one by default).

## Multiple projects

One Atlas app can serve separate private project channels. Stop the runner before editing its private `config.json`. Keep the existing `repoPath` for compatibility, and add `projects` entries with a unique `key`, absolute `repoPath`, and `channelIds` array. When project mappings are present, every `allowedChannelIds` entry must belong to exactly one project. All projects share the existing private worktree root; adding a project does not move saved conversations.

Use `enigma-work`, `enigma-pull-requests`, `enigma-code-review`, and `enigma-updates` for Enigma, with the same suffixes under `jarvis-` for Jarvis. Use explicit channel IDs and invite Atlas to each private channel. Each conversation runs against its channel's configured repository. Give each project a dedicated source checkout so another task's branch changes do not change the starting point for new Slack conversations. Refresh that checkout safely from the intended release branch before starting new work; preserve existing conversations and branches.

## Greptile review

Use the existing Greptile GitHub installation for the configured repositories. Completed changes become Ready for Review PRs, receive one initial Greptile review, and get tested repairs without requesting another review. You perform the final Merge action. See [the review workflow](REVIEW-WORKFLOW.md) and [monitor operating prompt](REVIEW-MONITOR.md).

A separately activated Codex heartbeat checks GitHub every ten minutes and coordinates repairs and durable Slack notices. It requires Codex to remain open on an awake, connected computer. The Slack runner's Windows startup task and the Codex heartbeat are separate: a saved policy file alone does not activate monitoring. Existing Greptile access and account allowance must be available; the bridge never purchases a subscription or creates provider credentials.
