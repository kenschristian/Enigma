# Internal interfaces

All modules are Node.js ES modules and must be importable without starting network clients. No third party runtime dependencies. Tests use node:test.

## Codex (Bridge owns src/codex.mjs, test/codex.test.mjs)

Export `CodexClient`.
Constructor `{ command = 'codex', args = [], cwd, requestTimeoutMs = 30000, spawnFn? }`.
Methods: `start()` handshake; `account()` safe account/read result; `models()` model array; `run({threadId?, cwd, model, effort, instructions, prompt, config?, timeoutMs?, signal?, onThread?, onProgress?, onApproval?})` returning `{threadId, turnId, text, status}`; `close()`.
Use thread/start or thread/resume, then turn/start. Await onThread(threadId) before starting model work so it can be saved. Pass explicit model and effort; fail if unavailable, never substitute. Check ChatGPT account in main before running. Workspace-write sandbox and never silently allow escalation; deny server approval/tool/user-input requests, call onApproval with safe method/reason. Signal or timeout interrupts and terminates active work. Handle interleaved notifications, child exit, malformed input, and final messages. No logging raw protocol/errors that can contain secrets. Expose read-only doctor functionality through account and models.

## Persistence (Forge owns src/store.mjs, src/worktrees.mjs, corresponding tests)

Export `TaskStore(path)` using node:sqlite. Synchronous methods:
- `enqueue({eventId, conversationKey, role, prompt, channel, slackThreadTs, userId, teamId, botKey})` returns `{created, task}`; unique eventId.
- `get(id)`, `list({status?,limit?}={})`, `nextQueued()`, `update(id, patch)`.
- Tasks include id (UUID), status, createdAt, updatedAt, codexThreadId, worktreePath, branch, result, error, plus enqueue fields. Default status queued.
- `conversation(conversationKey)` returns last task with its saved Codex/worktree metadata or null.
- `recoverInterrupted()` changes running tasks to interrupted and returns count. Queued tasks remain queued.
- `addOutbox({taskId?, botKey, channel, threadTs, text})`, `pendingOutbox(limit=20)`, `markDelivered(id)`, `failDelivery(id)` retry accounting. Durable messages, no unbounded parallel sends.
- `close()`.
- `interruptedTask(conversationKey, exceptId='')` and `hasLaterActiveTask(id)` provide complete conversation checks without bounded-list scans. `failDelivery(id, minimumDelayMs=0)` respects Slack rate-limit backoff. Outbox returns only the oldest undelivered message per destination.
Export `WorktreeManager({repoPath, worktreesRoot, gitCommand='git'})`. Async `ensure(conversationKey)` returns `{path,branch}`. Require repo with HEAD, use argv not shell, worktree name based on stable hash; validate existing mapping before reuse, preserve user changes, never reset/delete. `inspect()` returns branch, clean and remote metadata without fetching or mutation.

## Windows setup (Nova owns scripts/, docs/, manifests/, README.md)

Create secure PowerShell setup that writes configuration under `$env:LOCALAPPDATA\EnigmaAgents\config.json`, outside OneDrive. Ask tokens with Read-Host -AsSecureString and encrypt per-user using Windows DPAPI; runtime receives via a wrapper process environment only, never command arguments. Config shape below. Provide Start-Agents.ps1, Setup.ps1, Install-Startup.ps1, Remove-Startup.ps1, role Slack manifests. Scheduled Task at current-user logon, hidden, bounded restarts, no elevated rights; do not register before configuration is ready. No service-password collection. Explain after reboot starts at sign-in, and offline messages need resending; interrupted work requires explicit resume.

Config JSON schema: `{version:1, repoPath:absolute, stateDir:absolute, worktreesRoot:absolute, codexCommand:absolute, allowedTeamId:'T...', allowedUserIds:['U...'], allowedChannelIds:['C...'], maxConcurrent:1, taskTimeoutMinutes:45, bots:[{key:'atlas', role:'atlas', botTokenEnv:'ENIGMA_ATLAS_BOT_TOKEN', appTokenEnv:'ENIGMA_ATLAS_APP_TOKEN'}]}`. Role values atlas/frontend/backend/api. 1-4 bots. Single Atlas bot accepts `nova:`, `forge:`, `bridge:`, `atlas:` prefixes. Configure one Atlas initially, optional separately named identities. DPAPI encrypted values saved in secrets.json beside config, mapping environment names to ciphertext. Start wrapper decrypts tokens into child environment, resolves Node, starts `src/main.mjs --config <path>`, logs safe output with size limits. Setup locates existing Codex and Node; runs doctor before startup installation. Do not install dependencies or create provider accounts. No actual Slack credentials available yet.

## Root-owned modules

Atlas owns configuration, Slack WebSocket/HTTP transport, main entry point, routing/queue service, roles, and integration tests. Default run concurrency one to conserve allowance, configurable 1-3 jobs (each Atlas task can have native specialists). Slash-like text commands `help`, `status`, `resume <id>`, `cancel <id>` are recognized only after authorization. Channel work requires explicit bot mention. Workspace and user IDs are validated before task acceptance.
