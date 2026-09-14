export const taskKind = task => task.kind ?? (task.conversationKey.endsWith(':control') ? 'control' : 'coding');
export const slackThreadKey = task => `${task.teamId}:${task.channel}:${task.slackThreadTs}`;

export const DEVIN_SELECTED = 'This Slack thread is reserved for native Devin. Enigma will not run Codex work here. Send your task directly to @Devin to start its native session. Enigma cannot observe direct Devin mentions or verify its session state. Use a fresh Slack thread for Codex; do not launch both executors for the same task.';
export const executorError = code => code === 'PROJECT_MAPPING_CHANGED'
  ? 'This thread’s saved project mapping changed. Start a fresh thread in the correct project channel; saved work is preserved.'
  : code === 'THREAD_RESERVED_DEVIN'
    ? DEVIN_SELECTED
    : 'This thread has Codex work or saved coding history. Devin cannot be selected here. Finish or inspect the existing work, then use a fresh Slack thread for a separate Devin task.';

/** A structured template only: no model, repository inspection or native session creation. */
export function devinPrompt(task, config) {
  const project = config.projects?.find(project => project.channelIds.includes(task.channel));
  const repository = project?.repositoryFullName;
  const channels = Object.entries(project?.channels ?? {}).filter(([, id]) => project.channelIds.includes(id) && config.allowedChannelIds.includes(id));
  return `${DEVIN_SELECTED}\n\nStructured Devin prompt template (no code investigation performed):\n\n` +
    `${repository ? `Repository: ${repository}` : 'Repository: verify the intended repository before making changes.'}\n` +
    `${channels.length ? `Configured private Slack channels: ${channels.map(([purpose, id]) => `${purpose}=${id}`).join(', ')}.` : 'Use the project’s configured private -work, -code-review, -pull-requests and -updates channels; verify their IDs before sending.'}\n` +
    `Notification owner Slack ID: ${task.userId}.\n` +
    `Task supplied by the user:\n${task.prompt}\n\n` +
    'For this user-selected task, Devin is the lead publisher and may commit, push and create the PR; Codex workers remain local-only. Use the native session’s configured model and reasoning settings; this prompt does not change those runtime controls.\n' +
    'Read applicable AGENTS.md and project instructions. Confirm the intended repository and preserve existing work. Work in an isolated branch or worktree. Clarify missing acceptance criteria before dependent work; implement only the requested scope. Coordinate useful independent specialists with explicit file ownership when supported.\n' +
    'Run appropriate tests and required checks, review the final diff, and report changed files, actual results, branch/commit, and limitations. Keep credentials out of replies. Never provision provider accounts, API keys, or subscriptions.\n' +
    'Follow the project’s PR and review workflow. The selected Devin lead owns publication; specialists must not push, merge or deploy. Prepare one PR Ready for Review after appropriate tests and final diff review. Use one initial Greptile review, assess its findings, repair valid findings and validate repairs without requesting another review. Preserve disabled draft/update triggers.\n' +
    'Report findings and repairs in the configured code-review channel. Before the Merge handoff, verify the current final PR head, resolve valid findings, and pass required checks for that head. Tag the notification owner in the configured pull-requests channel with the PR link, final commit, repair summary, actual tests and remaining limitations; state that repaired commits were validated without a second Greptile review. Never claim a missing review or failed check passed.\n' +
    'The user performs the final Merge action. Never merge, enable auto-merge, bypass protections, or deploy. Report confirmed merges in the configured updates channel only after verification. Do not start or delegate this task to the Enigma Codex bridge.';
}
