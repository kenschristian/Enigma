import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { projectIdentity } from '../src/projects.mjs';
import { AgentService } from '../src/service.mjs';
import { TaskStore } from '../src/store.mjs';

const root = path.join(os.tmpdir(), 'enigma-project-binding');
const connection = { bot: { key: 'atlas', role: 'atlas' }, botUserId: 'UBOT' };
const configured = () => ({
  repoPath: path.join(root, 'enigma'), worktreesRoot: path.join(root, 'trees'),
  allowedTeamId: 'T1', allowedUserIds: ['U1'], allowedChannelIds: ['CENIGMA', 'CJARVIS'],
  maxConcurrent: 1, taskTimeoutMinutes: 1,
  projects: [
    { key: 'enigma', repoPath: path.join(root, 'enigma'), channelIds: ['CENIGMA'] },
    { key: 'jarvis', repoPath: path.join(root, 'jarvis'), channelIds: ['CJARVIS'] },
  ],
});
const event = (id, channel = 'CENIGMA') => ({
  type: 'event_callback', team_id: 'T1', event_id: id,
  event: { type: 'app_mention', user: 'U1', channel, text: '<@UBOT> Continue the task', ts: '1.1', thread_ts: '1.1' },
});
function fixture(config, store) {
  const seen = { ensure: [], clients: [], runs: [] };
  const service = new AgentService({ config, store,
    worktreesFor: task => ({ ensure: async key => {
      seen.ensure.push(key);
      return { path: task.worktreePath || path.join(root, 'trees', task.channel), branch: task.branch || 'codex/binding-test' };
    } }),
    clientFactory: task => {
      seen.clients.push(task.id);
      return { start: async () => {}, close: async () => {}, run: async params => {
        seen.runs.push(params);
        await params.onThread(params.threadId || 'saved-thread');
        return { status: 'completed', text: 'Done.' };
      } };
    },
  });
  return { service, seen };
}
async function drain(service) {
  service.pump();
  while (service.active.size) await Promise.allSettled([...service.active.values()].map(active => active.promise));
}
function oldTask(store, channel, established) {
  const { task } = store.enqueue({ eventId: 'legacy', conversationKey: `T1:${channel}:1.1:atlas`, role: 'atlas',
    prompt: 'Continue saved work', channel, slackThreadTs: '1.1', userId: 'U1', teamId: 'T1', botKey: 'atlas' });
  if (established) store.update(task.id, { worktreePath: path.join(root, 'trees', channel), branch: 'codex/legacy', codexThreadId: 'legacy-thread' });
  return task;
}

test('project identity normalizes paths while distinguishing project keys and repositories', () => {
  const config = configured();
  const identity = projectIdentity(config, 'CENIGMA');
  const alternate = configured();
  alternate.projects[0].repoPath = `${root}${path.sep}unused${path.sep}..${path.sep}enigma`;
  assert.equal(projectIdentity(alternate, 'CENIGMA'), identity);
  alternate.projects[0].key = 'renamed';
  assert.notEqual(projectIdentity(alternate, 'CENIGMA'), identity);
  assert.notEqual(projectIdentity(config, 'CJARVIS'), identity);
  assert.throws(() => projectIdentity(config, 'CUNKNOWN'), /not allowed/);
  alternate.projects[0].repoPath = 'relative';
  assert.throws(() => projectIdentity(alternate, 'CENIGMA'), /invalid project identity/);
});

test('project identity uses Windows case-insensitive path semantics', { skip: process.platform !== 'win32' }, () => {
  const config = configured();
  const upper = configured();
  upper.projects[0].repoPath = upper.projects[0].repoPath.toUpperCase();
  assert.equal(projectIdentity(config, 'CENIGMA'), projectIdentity(upper, 'CENIGMA'));
});

test('queued work cannot switch repositories when channel mappings change across restart', async t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const config = configured();
  const before = fixture(config, store);
  before.service.receive(event('first'), connection);
  const queued = store.list()[0];
  assert.equal(queued.projectIdentity, projectIdentity(config, 'CENIGMA'));
  const changed = configured();
  changed.projects = [{ ...changed.projects[1], channelIds: changed.allowedChannelIds }];
  const after = fixture(changed, store);
  await drain(after.service);
  assert.equal(store.get(queued.id).status, 'failed');
  assert.equal(store.get(queued.id).error, 'PROJECT_MAPPING_CHANGED');
  assert.deepEqual(after.seen.ensure, []);
  assert.deepEqual(after.seen.clients, []);
});

test('unchanged project mapping resumes the saved Codex thread after restart', async t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const config = configured();
  const before = fixture(config, store);
  before.service.receive(event('first', 'CJARVIS'), connection);
  await drain(before.service);
  const after = fixture(configured(), store);
  after.service.receive(event('second', 'CJARVIS'), connection);
  await drain(after.service);
  assert.equal(after.seen.runs.length, 1);
  assert.equal(after.seen.runs[0].threadId, 'saved-thread');
  assert.equal(store.list()[0].projectIdentity, projectIdentity(config, 'CJARVIS'));
  assert.equal(store.list()[0].status, 'completed');
});

test('legacy work without an established worktree fails closed after projects are enabled', async t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const task = oldTask(store, 'CENIGMA', false);
  const { service, seen } = fixture(configured(), store);
  await drain(service);
  assert.equal(store.get(task.id).status, 'failed');
  assert.equal(store.get(task.id).error, 'PROJECT_MAPPING_CHANGED');
  assert.deepEqual(seen.ensure, []);
  assert.deepEqual(seen.clients, []);
});

test('established legacy Enigma work may resume only in the legacy repository', async t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const task = oldTask(store, 'CENIGMA', true);
  const { service, seen } = fixture(configured(), store);
  await drain(service);
  assert.equal(store.get(task.id).status, 'completed');
  assert.equal(seen.ensure.length, 1);
  assert.equal(seen.runs[0].threadId, 'legacy-thread');
  assert.equal(seen.runs[0].cwd, task.worktreePath || path.join(root, 'trees', 'CENIGMA'));
});

test('established legacy work is rejected before ensure or client startup in Jarvis', async t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const task = oldTask(store, 'CJARVIS', true);
  const { service, seen } = fixture(configured(), store);
  await drain(service);
  assert.equal(store.get(task.id).status, 'failed');
  assert.equal(store.get(task.id).error, 'PROJECT_MAPPING_CHANGED');
  assert.deepEqual(seen.ensure, []);
  assert.deepEqual(seen.clients, []);
});
