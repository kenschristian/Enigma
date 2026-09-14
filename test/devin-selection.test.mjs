import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/store.mjs';
import { AgentService } from '../src/service.mjs';
import { projectIdentity } from '../src/projects.mjs';

const connection = { bot: { key: 'atlas', role: 'atlas' }, botUserId: 'UBOT' };
const config = () => ({ repoPath: path.join(os.tmpdir(), 'devin-repo'),
  allowedTeamId: 'T1', allowedUserIds: ['U1'], allowedChannelIds: ['C1'],
  bots: [{ key: 'atlas', role: 'atlas' }, { key: 'nova', role: 'frontend' }], maxConcurrent: 2, taskTimeoutMinutes: 1,
  projects: [{ key: 'enigma', repoPath: path.join(os.tmpdir(), 'devin-repo'), repositoryFullName: 'owner/Enigma', channelIds: ['C1'] }],
});
const event = (id, text, patch = {}) => ({ type: 'event_callback', team_id: 'T1', event_id: id,
  event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1.1', text: `<@UBOT> ${text}`, ...patch } });
function fixture(t, store = new TaskStore(':memory:')) {
  const c = config(), calls = [];
  const service = new AgentService({ config: c, store,
    worktrees: { ensure: async () => { calls.push('worktree'); throw new Error('Unexpected worktree'); } },
    clientFactory: () => { calls.push('model'); throw new Error('Unexpected model'); },
  });
  t.after(() => store.close());
  return { c, store, service, calls, receive: (id, text, patch) => service.receive(event(id, text, patch), connection) };
}
const messages = store => store.db.prepare('SELECT text FROM outbox ORDER BY sequence').all().map(row => row.text).join('\n');
const input = (eventId, patch = {}) => ({ eventId, teamId: 'T1', userId: 'U1', channel: 'C1', slackThreadTs: '1.1',
  conversationKey: 'T1:C1:1.1:atlas', role: 'atlas', botKey: 'atlas', prompt: 'Task', projectIdentity: 'project-one', ...patch });

test('preparation creates a durable structured template once with zero worktree or model calls', async t => {
  const f = fixture(t);
  f.receive('one', 'prepare a Devin prompt: Fix the accessible menu');
  f.receive('one', 'prepare a Devin prompt: Fix the accessible menu');
  f.service.pump();
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.list().length, 1);
  const task = f.store.list()[0];
  assert.equal(task.kind, 'devin-prompt');
  assert.equal(task.status, 'completed');
  assert.equal(task.codexThreadId, null);
  assert.equal(task.worktreePath, null);
  assert.equal(task.branch, null);
  assert.equal(f.store.threadExecutor(task).executor, 'devin');
  assert.equal(f.store.threadExecutor(task).projectIdentity, projectIdentity(f.c, 'C1'));
  const text = messages(f.store);
  assert.equal(text.match(/Structured Devin prompt template/g).length, 1);
  assert.match(text, /no code investigation performed/);
  assert.match(text, /Repository: owner\/Enigma/);
  assert.match(text, /Fix the accessible menu/);
  assert.match(text, /cannot observe direct Devin mentions/);
  assert.match(text, /user performs the final Merge/);
  assert.match(text, /Devin is the lead publisher and may commit, push and create the PR/);
  assert.match(text, /Notification owner Slack ID: U1/);
  assert.match(text, /does not change those runtime controls/);
  assert.ok(!text.includes(f.c.repoPath));
});

test('selection blocks all Codex role routes and resume while help, status and cancel remain controls', t => {
  const f = fixture(t);
  f.receive('select', 'use devin');
  for (const role of ['atlas', 'nova', 'forge', 'bridge']) f.receive(role, `${role}: implement this`);
  const nova = { bot: { key: 'nova', role: 'frontend' }, botUserId: 'UNOVA' };
  f.service.receive(event('native-bot', '', { text: '<@UNOVA> implement this' }), nova);
  const rejected = f.store.list().filter(task => task.kind === 'coding');
  assert.equal(rejected.length, 5);
  assert.ok(rejected.every(task => task.status === 'cancelled' && task.error === 'THREAD_RESERVED_DEVIN'));
  f.receive('resume', `resume ${rejected[0].id}`);
  f.receive('cancel', `cancel ${rejected[0].id}`);
  f.receive('help', 'help');
  f.receive('status', 'status');
  f.service.pump();
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.get(rejected[0].id).status, 'cancelled');
  assert.match(messages(f.store), /executor: devin/);
  assert.match(messages(f.store), /Native session state is not observed/);
  assert.equal(f.store.enqueue(input('fresh', { slackThreadTs: '2.2', conversationKey: 'T1:C1:2.2:atlas' })).task.status, 'queued');
});

test('malformed and specialist preparation never claims ownership or runs coding', t => {
  const f = fixture(t);
  for (const [id, text] of [['empty', 'prepare a Devin prompt: '], ['colon', 'prepare a Devin prompt'],
    ['large', `prepare a Devin prompt: ${'a'.repeat(20000)}`], ['role', 'nova: use devin']]) f.receive(id, text);
  const nova = { bot: { key: 'nova', role: 'frontend' }, botUserId: 'UNOVA' };
  f.service.receive(event('specialist', '', { text: '<@UNOVA> prepare a Devin prompt: task' }), nova);
  f.service.pump();
  assert.deepEqual(f.calls, []);
  assert.ok(f.store.list().every(task => task.kind === 'control'));
  assert.equal(f.store.threadExecutor(input('check')), null);
});

test('unauthorized and bot deliveries plus native-only Devin mentions stay ignored', t => {
  const f = fixture(t);
  for (const patch of [{ user: 'UOTHER' }, { channel: 'COTHER' }, { bot_id: 'B1' }, { subtype: 'bot_message' },
    { subtype: 'message_changed' }, { hidden: true }, { type: 'message' }, { text: '<@UDEVIN> do the task' }]) {
    assert.equal(f.receive('ignored', 'use devin', patch), false);
  }
  const wrongTeam = event('wrong', 'use devin'); wrongTeam.team_id = 'TOTHER';
  assert.equal(f.service.receive(wrongTeam, connection), false);
  assert.equal(f.store.list().length, 0);
  assert.equal(f.store.threadExecutor(input('check')), null);
});

test('all historical coding statuses across role keys block Devin even before ownership migration', t => {
  for (const status of ['queued', 'running', 'interrupted', 'failed', 'completed', 'cancelled']) {
    const store = new TaskStore(':memory:');
    try {
      const prior = store.enqueue(input('old', { role: 'frontend', conversationKey: 'T1:C1:1.1:frontend' })).task;
      store.update(prior.id, { status, worktreePath: '/saved/work', branch: 'codex/saved' });
      const legacy = store.get(prior.id); delete legacy.kind;
      store.db.prepare('UPDATE tasks SET data = ? WHERE id = ?').run(JSON.stringify(legacy), prior.id);
      store.db.exec('DELETE FROM thread_executors');
      const selected = store.enqueue(input('select', { kind: 'devin-selection', conversationKey: 'T1:C1:1.1:atlas:control' })).task;
      assert.equal(selected.error, 'THREAD_RESERVED_CODEX', status);
      assert.equal(store.threadExecutor(selected).executor, 'codex');
      assert.equal(store.get(prior.id).worktreePath, '/saved/work');
    } finally { store.close(); }
  }
});

test('ownership, preparation dedupe and task kind survive reopen and competing connections', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devin-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tasks.db');
  const first = new TaskStore(file), second = new TaskStore(file);
  try {
    const selection = input('select', { kind: 'devin-prompt', conversationKey: 'T1:C1:1.1:atlas:control' });
    const accepted = first.enqueueWithReply(selection, () => ['Saved template']);
    const competing = second.enqueue(input('code', { role: 'frontend', conversationKey: 'T1:C1:1.1:frontend' }));
    assert.equal(competing.task.error, 'THREAD_RESERVED_DEVIN');
    assert.equal(second.enqueueWithReply(selection, () => { throw new Error('Must not repeat'); }).created, false);
    assert.throws(() => second.update(accepted.task.id, { kind: 'coding' }), /cannot be updated/);
    assert.throws(() => second.update(accepted.task.id, { status: 'queued' }), /Only coding tasks/);
    assert.throws(() => second.update(competing.task.id, { status: 'running' }), /executor prevents coding/);
  } finally { first.close(); second.close(); }
  const reopened = new TaskStore(file);
  try {
    assert.equal(reopened.threadExecutor(input('read')).executor, 'devin');
    assert.equal(reopened.threadExecutor(input('read')).sourceEventId, 'select');
    assert.equal(reopened.nextQueued(), null);
    assert.equal(messages(reopened), 'Saved template');
  } finally { reopened.close(); }
});

test('coding wins a competing selection and response failure rolls back selection before Slack ack', t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const selection = input('select', { kind: 'devin-selection', conversationKey: 'T1:C1:1.1:atlas:control' });
  assert.throws(() => store.enqueueWithReply(selection, () => { throw new Error('reply failure'); }), /reply failure/);
  assert.equal(store.threadExecutor(selection), null);
  assert.equal(store.list().length, 0);
  store.enqueue(input('code', { role: 'frontend', conversationKey: 'T1:C1:1.1:frontend' }));
  assert.equal(store.enqueue(selection).task.error, 'THREAD_RESERVED_CODEX');
});

test('a remapped Devin reservation never relabels the saved project or produces a new template', t => {
  const f = fixture(t);
  f.receive('select', 'use devin');
  f.c.projects[0].repoPath = path.join(os.tmpdir(), 'other-repo');
  f.receive('prepare', 'prepare a Devin prompt: another task');
  const rejected = f.store.list()[0];
  assert.equal(rejected.error, 'PROJECT_MAPPING_CHANGED');
  assert.notEqual(f.store.threadExecutor(rejected).projectIdentity, rejected.projectIdentity);
  assert.ok(!messages(f.store).includes('Structured Devin prompt template'));
  f.service.pump(); assert.deepEqual(f.calls, []);
});

test('execution rechecks reserved ownership and noncoding kind for previously queued state', t => {
  const f = fixture(t);
  f.receive('select', 'use devin');
  f.receive('code', 'implement this');
  const rejected = f.store.list()[0], selected = f.store.list()[1];
  for (const task of [rejected, selected]) {
    task.status = 'queued';
    f.store.db.prepare('UPDATE tasks SET status = ?, data = ? WHERE id = ?').run('queued', JSON.stringify(task), task.id);
  }
  f.service.pump();
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.get(rejected.id).status, 'cancelled');
  assert.equal(f.store.get(selected.id).status, 'cancelled');
});
