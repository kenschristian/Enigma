# Enigma

Enigma connects a private Slack channel to the installed Codex app-server on your Windows computer. You send a request to Atlas; work runs in an isolated Git worktree using your existing ChatGPT subscription sign-in. There are no npm runtime dependencies or OpenAI API keys.

Start with **[Windows setup](docs/SETUP.md)**. Slack workspace: [enigma777](https://enigma777.slack.com). Repository: [kenschristian/Enigma](https://github.com/kenschristian/Enigma).

```text
@Atlas help
@Atlas Fix the settings page and add a focused regression check.
@Atlas nova: Improve keyboard navigation in the settings dialog.
@Atlas forge: Investigate the slow database query.
@Atlas bridge: Review the API input validation.
@Atlas status
@Atlas resume <task-id>
@Atlas cancel <task-id>
```

Use a real Slack mention in an explicitly allowed channel. These are ordinary messages, not slash commands. Atlas is the default identity; separate Nova, Forge, and Bridge apps are optional. Runtime roles are `frontend`, `backend`, and `api`.

The bridge checks the workspace, sender, and channel before accepting work. Bot messages and duplicate events are ignored. Workspaces and incomplete changes are retained after interruptions. Escalation requests are never automatically approved. Specialists prepare work for Atlas to review; the human clicks the final GitHub **Merge** action.

Private settings, encrypted Slack credentials, task history, and runtime worktrees live under `%LOCALAPPDATA%\EnigmaAgents`, outside OneDrive and Git. The Windows wrapper starts after you sign in, with a single process per state directory and bounded restart attempts. Your computer must stay awake and online. Messages sent while offline may need resending; interrupted work needs an explicit `resume`.

For development, use Node.js 24+ and run:

```powershell
node --test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Scripts.ps1
```

Building and testing locally does not activate Slack or install startup. See [operations and troubleshooting](docs/OPERATIONS.md) for restart, credential rotation, and verification steps.
