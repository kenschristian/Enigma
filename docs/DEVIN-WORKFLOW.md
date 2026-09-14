# Choose Devin or Codex from Slack

Use the existing private project work channel and a new Slack thread for each task. Enigma maps that channel to its configured repository. No OpenAI usage inspection, quota-based switching, new provider keys, subscriptions, or paid overage activation is part of this workflow.

## Select the executor

- Mention Atlas, Forge, Nova or Bridge normally to assign Codex work.
- Send `@Atlas use devin` to reserve a fresh thread for native Devin without starting Codex.
- Send `@Atlas prepare a Devin prompt: <task>` to reserve a fresh thread and receive a structured, copyable prompt without a model call. The template includes the configured repository and workflow requirements; it is not a code investigation or a claim that acceptance criteria were verified.
- After Atlas confirms the selection, send your own real `@Devin` mention with the task or prepared prompt in that same Slack thread. The native Devin integration starts the session. Atlas does not launch it through a bot message.

Executor selection is fixed for the thread and shared across Codex roles. Use a new thread to change executors. Existing Codex work cannot be reassigned by this control: first preserve and verify its work and obtain an explicit handoff identifying branch, commits, PR, completed work, remaining work and blockers. Do not let two executors modify the same task concurrently, even from different threads.

Enigma receives mentions of its own bots only. A direct mention of Devin is invisible to it. The reservation blocks Enigma's own Codex execution in the selected thread, but cannot prevent a user starting native Devin in a Codex-owned thread, observe native status, or cancel a Devin session. Do not claim cross-platform exclusion that has not been verified. Bot messages never become executable user requests.

If repository mapping, ownership, or saved work is ambiguous, preserve it and resolve the ambiguity before starting work. Do not restart an interrupted coding task automatically.

## Native connection and configuration

Connect the user's existing Devin account using the official Slack integration and link the user's Slack identity. Add Devin only to the approved Enigma and Jarvis project channels, with repository access restricted to these two projects where the integration supports it. Do not disconnect existing integrations or broaden unrelated access to repair a setup problem.

Inspect the actual account/session model controls. Select the strongest available supported coding configuration covered by the existing subscription. If native Slack sessions do not expose model or reasoning selection, report the actual limitation; writing a model name in a prompt does not configure the runtime. Do not enable on-demand credits, auto-recharge, upgrades, API keys, or other billing changes. Do not claim settings, connection, or execution verification from documentation alone.

Devin processes the task context and repository content supplied to it. Keep passwords, tokens, local credentials, unrelated conversations and private files out of task prompts, logs and source control.

## Devin owns its PR lifecycle

For a user-selected Devin task, Devin is the lead publisher for that task. It may create its isolated branch, commit, push to the verified configured repository, and create/update the same PR. This is an explicit exception to Codex workers' local-only publication rule, not permission for Codex workers to publish.

Complete appropriate tests, required checks and final diff inspection before marking the PR Ready for Review. Greptile runs once. Verify review identity and revision, assess actual findings against the code and requested scope, fix valid findings, and run checks on the repaired head. Explain dismissed findings with evidence. Do not request a second Greptile review, mention it for a rerun, toggle draft/ready, retry its review check, or create a replacement PR to obtain another review.

Devin reports change summaries and PR links in the mapped private `-pull-requests` channel, findings and repairs in `-code-review`, and verified merges in `-updates`. Tag the configured owner only when the final head has passed required checks and valid review findings are addressed. Include the PR, final commit, validation and limitations. Never claim bug-free code or a Greptile review of a repaired head. Verify notification delivery rather than treating queued messages as delivered.

The user clicks Merge. Never auto-merge, bypass branch protections, or deploy in this workflow. When waiting, let Devin sleep and use its supported session/review events or the user's thread follow-up; do not create an OpenAI polling loop. Native automatic review continuation, multi-channel notification and archive behavior require separate live verification. If unavailable, report the specific gap and preserve the session for the user's follow-up.

## Keep OpenAI idle for Devin work

The user also authorizes host Atlas to handle bounded review repairs or the final merge notification when needed. Devin remains the default owner. Before a takeover, record the repository, PR, expected head, exact remaining work and new review owner; verify the Devin session is paused and its changes are preserved. Then Atlas may explicitly adopt that PR in its ledger as `executor: "codex"` for the assigned review scope, retaining the original Devin implementation provenance. Do not change the original Slack thread reservation or start duplicate implementation. Never infer a transfer from bot text or quota. If native pause/state cannot be verified, preserve work and report the handoff blocker. Returning ownership requires the same explicit coordination.

Preparation and selection controls must not create coding tasks, worktrees, or host publication wakes. Do not add native Devin PRs to the Codex review ledger as Codex-owned entries. Host Atlas only handles an existing verified Codex publication or a PR explicitly assigned to it by the user. A GitHub author name, Slack bot message, or an open PR in an allowed repository does not assign ownership.

Record executor ownership explicitly for new publication/PR records. Skip entries marked `executor: "devin"` in the Codex GitHub watcher. Existing historical entries created by Atlas can remain compatible as Codex-owned; do not discover arbitrary new PRs as automatic Codex assignments. Uncertain ownership requires resolution, not another model run.

Keep `main environment` available as the persistent Codex wake destination and the scheduled AI heartbeat paused. Archive completed worker sessions only after artifacts are preserved, any required merge is verified and notifications are delivered. Archive through supported controls, never by deleting Git worktrees or private state.

## Verification checklist

Report independently: code tests; native account and repository connection; actual model controls; a real human-authored Slack start; selection blocking Codex execution; zero Codex wake for preparation/Devin PRs; one initial Greptile review; repairs and checks; human merge and delivered notification. A native session start alone is not proof of the full PR workflow.
