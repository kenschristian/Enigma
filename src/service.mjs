import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { MODEL, ROLES, redact } from './config.mjs';
import { roleInstructions, agentConfig } from './roles.mjs';
import { splitMessage } from './slack.mjs';
import { projectIdentity } from './projects.mjs';

const aliases = { atlas: 'atlas', nova: 'frontend', frontend: 'frontend', forge: 'backend', backend: 'backend', bridge: 'api', api: 'api' };
const HELP = 'Mention this bot with a task. Atlas coordinates Nova, Forge and Bridge. Use "nova: task", "forge: task" or "bridge: task" to work with one specialist. Mention the bot in the same Slack thread to continue. Controls: help, status, resume TASK-ID, cancel TASK-ID. Restarted tasks are saved and require resume; messages sent while this PC is offline may need resending.';

export function routeEvent(payload, connection, config) {
  const e = payload?.event;
  if (payload?.type !== 'event_callback' || payload.team_id !== config.allowedTeamId || !payload.event_id) return null;
  if (!e || e.type !== 'app_mention' || e.bot_id || e.subtype || e.hidden || (e.team && e.team !== config.allowedTeamId)) return null;
  if (!config.allowedUserIds.includes(e.user) || !config.allowedChannelIds.includes(e.channel)) return null;
  if (typeof e.text !== 'string' || !/^\d+\.\d+$/.test(e.ts) || (e.thread_ts && !/^\d+\.\d+$/.test(e.thread_ts))) return null;
  const mention = `<@${connection.botUserId}>`;
  if (!connection.botUserId || !e.text.includes(mention)) return null;
  let prompt = e.text.split(mention).join('').trim();
  // A human can mention multiple bots, but a dedicated specialist cannot impersonate another role.
  let role = connection.bot.role;
  const prefix = prompt.match(/^(atlas|nova|frontend|forge|backend|bridge|api)\s*:\s*/i);
  if (prefix && role === 'atlas') { role = aliases[prefix[1].toLowerCase()]; prompt = prompt.slice(prefix[0].length); }
  const slackThreadTs = e.thread_ts || e.ts;
  return { eventId: `${connection.bot.key}:${payload.event_id}`, conversationKey: `${payload.team_id}:${e.channel}:${slackThreadTs}:${role}`,
    role, prompt: prompt.trim(), channel: e.channel, slackThreadTs, userId: e.user, teamId: payload.team_id, botKey: connection.bot.key,
    ...(config.repoPath ? { projectIdentity: projectIdentity(config, e.channel) } : {}) };
}

export class AgentService {
  constructor({ config, store, worktrees, worktreesFor = () => worktrees, clientFactory, connections = new Map(), log = () => {} }) {
    Object.assign(this, { config, store, worktrees, clientFactory, connections, log });
    this.worktreesFor = worktreesFor;
    this.active = new Map(); this.stopping = false; this.flushing = false;
  }

  reply(task, text) {
    for (const part of splitMessage(redact(text))) this.store.addOutbox({ taskId: task.id, botKey: task.botKey, channel: task.channel, threadTs: task.slackThreadTs, text: part });
  }

  receive(payload, connection) {
    const input = routeEvent(payload, connection, this.config);
    if (!input) return false;
    const control = input.prompt.match(/^(help|status|resume|cancel)(?:\s+(\S+))?$/i);
    if (control || !input.prompt || input.prompt.length > 20000 || this.store.list({ status: 'queued', limit: 100 }).length >= 100) {
      const { created, task } = this.store.enqueue({ ...input, conversationKey: `${input.conversationKey}:control`, prompt: input.prompt.slice(0,20000) || 'help' });
      if (!created) return true;
      this.store.update(task.id, { status: 'completed' });
      if (!input.prompt) this.reply(task, HELP);
      else if (input.prompt.length > 20000) this.reply(task, 'Please split this request into messages under 20,000 characters.');
      else if (control) this.control(task, control[1].toLowerCase(), control[2]);
      else this.reply(task, 'The queue is full. Please wait for current work to finish.');
      return true;
    }
    // An interruption blocks follow-ups until the user explicitly resumes or cancels it.
    const blocked = this.store.interruptedTask(input.conversationKey);
    const { created, task } = this.store.enqueue(input);
    if (created) {
      if (blocked) { this.store.update(task.id, { status: 'cancelled' }); this.reply(task, `Task ${blocked.id} was interrupted. Use resume ${blocked.id} before sending more work in this thread.`); }
      else this.reply(task, `${ROLES[task.role]} queued task ${task.id}. Use status to check progress.`);
    }
    return true;
  }

  control(task, command, id) {
    if (command === 'help') return this.reply(task, HELP);
    if (command === 'status') {
      const tasks = this.store.list({ limit: 100 }).filter(t => t.userId === task.userId && t.channel === task.channel && !t.conversationKey.endsWith(':control')).slice(0, 10);
      return this.reply(task, tasks.length ? tasks.map(t => `${t.id} | ${ROLES[t.role]} | ${t.status}${t.branch ? ` | ${t.branch}` : ''}`).join('\n') : 'No tasks yet in this channel.');
    }
    const target = id ? this.store.get(id) : null;
    if (!target || target.userId !== task.userId || target.channel !== task.channel || target.teamId !== task.teamId || target.conversationKey.endsWith(':control')) return this.reply(task, 'Task not found. Use status and copy its full task ID.');
    if (command === 'resume') {
      if (!['interrupted', 'failed', 'cancelled'].includes(target.status)) return this.reply(task, 'Only interrupted, failed or cancelled tasks can be resumed.');
      const newer = this.store.hasLaterActiveTask(target.id);
      if (newer) return this.reply(task, 'A newer task exists in that conversation. Continue the latest task or start a new Slack thread.');
      this.store.update(target.id, { status: 'queued', error: null });
      this.reply(task, `Task ${target.id} is queued for recovery. Saved work will be inspected before continuing.`);
    } else {
      if (!['queued', 'running', 'interrupted'].includes(target.status)) return this.reply(task, `Task is already ${target.status}.`);
      this.active.get(target.id)?.controller.abort();
      this.store.update(target.id, { status: 'cancelled' });
      this.reply(task, `Cancelled task ${target.id}. Its files and saved conversation are preserved.`);
    }
  }

  start() {
    const interrupted = this.store.list({ status: 'running', limit: 1000 });
    this.store.recoverInterrupted();
    for (const task of interrupted) this.reply(task, `Task ${task.id} was interrupted by a restart. Saved work is preserved. Use resume ${task.id} to continue.`);
    this.timer = setInterval(() => { try { this.pump(); } catch { this.log('Task queue paused; local state needs attention.'); } void this.flush(); }, 1000);
    this.pump(); void this.flush();
  }

  pump() {
    if (this.stopping) return;
    while (this.active.size < this.config.maxConcurrent) {
      const task = this.store.nextQueued();
      if (!task) break;
      if ([...this.active.values()].some(a => a.conversationKey === task.conversationKey)) break;
      const interrupted = this.store.interruptedTask(task.conversationKey, task.id);
      if (interrupted) {
        this.store.update(task.id, { status: 'cancelled', error: 'Preceding task was interrupted.' });
        this.reply(task, `This follow-up is paused because ${interrupted.id} was interrupted. Resume that task, then resend this follow-up. Its original text is saved.`);
        continue;
      }
      this.store.update(task.id, { status: 'running' });
      const controller = new AbortController();
      const active = { controller, promise: null, conversationKey: task.conversationKey };
      this.active.set(task.id, active);
      active.promise = this.run(task, controller.signal).finally(() => { this.active.delete(task.id); });
    }
  }

  async run(task, signal) {
    let client;
    let approvalNeeded = false;
    try {
      let verifyLegacyWorktree = false;
      if (this.config.repoPath) {
        const expected = projectIdentity(this.config, task.channel);
        const legacy = projectIdentity({ ...this.config, projects: undefined }, task.channel);
        const bound = task.projectIdentity === expected;
        // Older tasks have no recorded project binding. Reuse only their already
        // established worktree in the legacy repository; never guess for queued work.
        const establishedLegacy = !task.projectIdentity && task.worktreePath && task.branch &&
          JSON.parse(expected)[1] === JSON.parse(legacy)[1];
        verifyLegacyWorktree = !!establishedLegacy;
        if (!bound && !establishedLegacy) {
          const error = new Error('The saved task repository mapping changed.');
          error.code = 'PROJECT_MAPPING_CHANGED';
          throw error;
        }
      }
      const worktree = await this.worktreesFor(task).ensure(task.conversationKey);
      if (verifyLegacyWorktree) {
        const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (worktree.branch !== task.branch || canonical(worktree.path) !== canonical(task.worktreePath)) {
          throw Object.assign(new Error('Legacy task worktree does not match saved work.'), { code: 'PROJECT_MAPPING_CHANGED' });
        }
      }
      client = this.clientFactory(task);
      this.store.update(task.id, { worktreePath: worktree.path, branch: worktree.branch });
      const previous = this.store.conversation(task.conversationKey);
      if (signal.aborted) return;
      await client.start();
      this.reply(task, `${ROLES[task.role]} started ${task.id}. Branch: ${worktree.branch}.`);
      const outcome = await client.run({
        threadId: previous?.codexThreadId || undefined, cwd: worktree.path, model: MODEL,
        effort: task.role === 'atlas' ? 'ultra' : 'high', instructions: roleInstructions(task.role), config: agentConfig,
        prompt: previous?.codexThreadId ? `Continue this conversation. First inspect the existing work and handoff notes; do not repeat completed actions.\n\n${task.prompt}` : task.prompt,
        timeoutMs: this.config.taskTimeoutMinutes * 60000, signal,
        onThread: threadId => this.store.update(task.id, { codexThreadId: threadId }),
        onApproval: () => { approvalNeeded = true; },
      });
      if (signal.aborted || this.store.get(task.id).status === 'cancelled') return;
      const status = approvalNeeded ? 'interrupted' : outcome.status === 'completed' ? 'completed' : outcome.status === 'interrupted' ? 'interrupted' : 'failed';
      const result = redact(outcome.text || 'No final answer was returned.');
      this.store.update(task.id, { status, result, error: status === 'completed' ? null : 'Needs attention. Review the task before resuming.' });
      this.reply(task, `${ROLES[task.role]} — ${status}\nTask ${task.id}\nBranch: ${worktree.branch}\n\n${result}${approvalNeeded ? '\n\nAn action requires approval in Codex. It was not approved through Slack. Open the saved work in Codex to review it.' : ''}`);
    } catch (error) {
      const current = this.store.get(task.id);
      if (current.status !== 'cancelled') {
        const status = this.stopping || signal.aborted || approvalNeeded ? 'interrupted' : 'failed';
        const safe = /^[A-Z_a-z0-9-]{1,60}$/.test(error?.code || '') ? error.code : 'TASK_FAILED';
        this.store.update(task.id, { status, error: safe });
        this.reply(task, safe === 'PROJECT_MAPPING_CHANGED'
          ? `Task ${task.id} stopped because its saved repository binding no longer matches this channel. Saved files are preserved. Restore the original project mapping, or start a new task in the correct project channel after reviewing the saved work.`
          : `Task ${task.id} ${status} (${safe}). Saved files are preserved. Check Codex sign-in and use resume ${task.id} after resolving the issue.`);
      }
    } finally {
      try { await client?.close(); }
      catch { this.stopping = true; this.log('Codex did not confirm shutdown. The task queue is paused; restart after checking the saved work.'); }
    }
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const message of this.store.pendingOutbox()) {
        const connection = this.connections.get(message.botKey);
        if (!connection) continue;
        try { await connection.post({ channel: message.channel, threadTs: message.threadTs, text: message.text, id: message.id, notifyUserId: message.notifyUserId, prUrl: message.prUrl }); this.store.markDelivered(message.id); }
        catch (error) { this.store.failDelivery(message.id, (error.retryAfter || 0) * 1000); break; }
      }
    } catch { this.log('Message delivery paused; retrying.'); }
    finally { this.flushing = false; }
  }

  async stop() {
    this.stopping = true; clearInterval(this.timer);
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(e => e.promise));
    while (this.flushing) await delay(25);
  }
}
