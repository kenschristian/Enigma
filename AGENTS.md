# Enigma Slack-to-Codex bridge

Follow the user's global team workflow. This project starts from an empty repository with no configured GitHub remote.

- Node.js 24+, ESM, built-in libraries. Use `node --test` for tests.
- Use the installed Codex app-server and ChatGPT subscription authentication only. Never provision an API key or silently fall back to API billing.
- Persist private configuration and task state under LOCALAPPDATA, outside OneDrive and Git.
- Only allow explicitly configured Slack workspace, user, and channel IDs. Ignore bot messages and duplicate deliveries.
- Keep agent work in isolated Git worktrees; preserve incomplete work after interruptions.
- Never automatically approve escalation requests. Keep coding sandboxed and surface requests that need the user.
- Do not push, merge to a remote, or deploy from workers. Atlas owns integration.
- Do not log credentials or raw RPC payloads.
