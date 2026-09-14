# Enigma

Enigma connects private project Slack channels to the installed Codex app-server on your Windows computer. You send a request to Atlas; work runs in the channel's assigned repository and an isolated Git worktree using your existing ChatGPT subscription sign-in. There are no npm runtime dependencies or OpenAI API keys.

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

Use a real Slack mention in an explicitly allowed channel. These are ordinary messages, not slash commands. The team profiles are **Atlas - Manager**, **Forge - Back End Engineer**, **Nova - Front End Engineer**, and **Bridge - API Engineer**, each with its own [avatar](assets/agents/README.md). Mention Atlas for coordinated work or a specialist for its own responsibility. Runtime roles remain `frontend`, `backend`, and `api`; at most three specialists run concurrently.

Use **#enigma-work** for this bridge and **#jarvis-work** for Jarvis. Each project also has private `-pull-requests`, `-code-review`, and `-updates` channels. The [team prompt](docs/SLACK-TEAM-PROMPT.md) explains their purposes. Completed coding work goes to Atlas for a **Ready for Review** pull request (PR). Greptile reviews once; agents fix valid issues, test the changes, and run required checks without requesting another Greptile pass. Wait for Atlas to tag you after those checks pass before clicking **Merge** on GitHub. The [review workflow](docs/REVIEW-WORKFLOW.md) and separately activated [Codex monitor](docs/REVIEW-MONITOR.md) govern that handoff.

The bridge checks the workspace, sender, and channel before accepting work. Bot messages and duplicate events are ignored. Workspaces and incomplete changes are retained after interruptions. Escalation requests are never automatically approved. Specialists prepare work for Atlas to review; the human clicks the final GitHub **Merge** action.

Private settings, encrypted Slack credentials, task history, and runtime worktrees live under `%LOCALAPPDATA%\EnigmaAgents`, outside OneDrive and Git. The Windows wrapper starts after you sign in, with a single process per state directory and bounded restart attempts. Your computer must stay awake and online. Messages sent while offline may need resending; interrupted work needs an explicit `resume`.

For development, use Node.js 24+ and run:

```powershell
node --test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-Scripts.ps1
```

Building and testing locally does not activate Slack or install startup. See [operations and troubleshooting](docs/OPERATIONS.md) for restart, credential rotation, and verification steps.
