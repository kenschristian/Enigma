# Validation and activation status

Local validation on 2026-09-13:

- Node.js 24.19.0, Windows PowerShell 5.1 and PowerShell 7.
- Unit/integration tests cover RPC framing, ChatGPT-only authentication, exact model/effort selection, denied approvals, cancellation, process shutdown, task routing, access checks, deduplication, restart recovery, SQLite persistence, reply ordering and Git worktree isolation.
- PowerShell parser and helper checks passed, including a synthetic current-user DPAPI encryption/decryption round trip. No real credentials were used in these tests.
- The installed Codex CLI 0.154.0-alpha.6.2 successfully authenticated with the existing ChatGPT account and reported GPT-6 Astra with High and Ultra.
- A live tool-free new conversation at High returned `ENIGMA_READY`. Resuming that same conversation at Ultra returned `ENIGMA_RESUMED`. These checks consumed the existing Codex allowance; no OpenAI API key was used.
- Existing personal `frontend`, `backend` and `api` agent definitions were verified as GPT-6 Astra High. The bridge requests a maximum of three native specialists and Atlas at Ultra.
- Slack accepted the Atlas manifest in its app creation review screen, with `app_mentions:read` and `chat:write` scopes and the `app_mention` event.

Still requires live activation and verification:

- Approve/create/install the Slack app, generate its app-level connection token, and save the two Slack tokens using the local encrypted setup.
- Select the allowed channel and user, then verify a real Slack request and response.
- Enable Windows startup only after the live foreground check succeeds.
- Validate native specialist delegation through a substantial real project task. The completed live smoke test verified Codex conversation start/resume, not a three-worker coding run.
- Greptile installation and review availability are not verified. No Greptile review has been requested.

The bridge uses Codex's persisted conversation plus its own SQLite queue and saved Git worktrees. It does not promise uninterrupted execution during reboot, offline Slack message replay, or automatic approval of actions requiring new permissions. Interrupted work requires an explicit resume. Local code changes have not been deployed to a hosted service.
