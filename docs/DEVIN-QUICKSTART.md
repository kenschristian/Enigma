# Devin quickstart: choose Codex or Devin in Slack

Each task in a project's private `-work` channel (`#enigma-work` for Enigma) runs on one executor per Slack thread: **Codex** (Atlas plus the Nova, Forge, and Bridge specialists) or **native Devin**. You pick per thread; nothing switches providers automatically.

> **Prerequisite:** the two selection commands below ship with [PR #6](https://github.com/kenschristian/Enigma/pull/6), the already-tested Devin routing change. Until that PR merges the commands are not live on `main` — though a direct native `@Devin` mention still works; it just isn't coordinated with Codex. The full Devin operating policy is `DEVIN-WORKFLOW.md` (added by PR #6); review rules are in `REVIEW-WORKFLOW.md`.

## 1. Pick the executor for the thread

- **Codex (default):** send a normal mention — `@Atlas <task>`, or `@Nova`, `@Forge`, `@Bridge` for role-scoped work. Specialists stay local-only; Atlas publishes the PR.
- **Native Devin:** send a real `@Devin <task>` mention in the thread. Reserving the thread first with an Atlas command (below) is recommended — it keeps Enigma's Codex bots from picking up work there.

## 2. Reserve a Devin thread — two Atlas commands

| Command | What it does |
| --- | --- |
| `@Atlas use devin` | Reserves a fresh thread for native Devin without starting Codex. Atlas replies with the reservation notice. |
| `@Atlas prepare a Devin prompt: <task>` | Same reservation, plus a structured, copyable prompt template — repository, configured channel IDs, notification owner, your task text, and the workflow rules. Produced with no model call and no code investigation; it is a template, not verified analysis. |

Both commands require a **new** thread with no Codex work or saved coding history. If the thread already has Codex work, finish it and open a fresh thread instead.

## 3. Start Devin with a real mention

Send your own `@Devin <task>` message — or paste the prepared prompt — in the thread. A real user `@Devin` mention starts the native session with or without a reservation; the Atlas reservation is a coordination step that blocks Codex bots in that thread, not a launch requirement. Enigma cannot observe `@Devin` mentions, launch a session through a bot reply, see native session state, or stop Devin — so the reservation notice itself neither starts nor gates Devin.

## 4. One executor per thread

- The executor choice is fixed for the thread and shared across all Codex roles.
- Switching executors means a fresh thread; an existing Codex thread cannot be reassigned to Devin.
- Never run both executors on the same task, even from separate threads. Preserve and verify prior work before any explicit handoff, and record branch, commits, PR, and remaining work.

## 5. Ready for Review to human Merge

1. Devin is the lead publisher for its assigned task: isolated branch, commit, push, one PR marked **Ready for Review** after tests, required checks, and a final diff review.
2. Greptile reviews **once**. `.greptile/config.json` keeps `triggerOnDrafts` and `triggerOnUpdates` at `false` — no rerun requests, `@greptileai` mentions, draft toggles, check retries, or replacement PRs.
3. Valid findings are fixed on the same PR and required checks (`node --test`, the Windows checks workflow) rerun on the final head; dismissed findings get an evidence-backed explanation. Repaired commits are validated by the agents — no second Greptile pass.
4. Findings and repairs are reported in `#enigma-code-review`. When valid findings are resolved and required checks pass on the final head, Devin tags Ken in `#enigma-pull-requests` with the PR link, final commit, validation results, and limitations.
5. **Ken clicks Merge.** No agent merges, enables auto-merge, bypasses protections, or deploys. The verified merge result is posted once in `#enigma-updates`.

If native review continuation or cross-channel posting is unavailable, the limitation is reported in the work thread so Atlas can take over the bounded repair or notification handoff — Devin stays the default owner.
