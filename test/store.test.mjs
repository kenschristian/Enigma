import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store.mjs';

const input = (eventId, conversationKey = 'conversation') => ({ eventId, conversationKey, role: 'backend', prompt: 'Implement change', channel: 'C123', slackThreadTs: '123.456', userId: 'U123', teamId: 'T123', botKey: 'forge' });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'enigma-store-'));
  const path = join(root, 'state', 'tasks.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });
  return () => { const store = new TaskStore(path); stores.push(store); return store; };
}

test('deduplicates durably and recovers interrupted tasks without restarting them', (t) => {
  const open = fixture(t);
  const store = open();
  const first = store.enqueue(input('event1'));
  const queued = store.enqueue(input('event2', 'other')).task;
  assert.equal(first.created, true);
  store.update(first.task.id, { status: 'running', codexThreadId: 'thread-1', worktreePath: '/work/1', branch: 'codex/1' });
  store.close();
  const reopened = open();
  assert.equal(reopened.enqueue(input('event1')).created, false);
  assert.equal(reopened.recoverInterrupted(), 1);
  assert.equal(reopened.recoverInterrupted(), 0);
  assert.equal(reopened.get(first.task.id).status, 'interrupted');
  assert.equal(reopened.get(first.task.id).codexThreadId, 'thread-1');
  assert.equal(reopened.nextQueued().id, queued.id);
  assert.equal(reopened.list({ status: 'interrupted' }).length, 1);
});

test('queue skips running conversations and guards concurrent claims across connections', (t) => {
  const open = fixture(t);
  const store = open();
  const a = store.enqueue(input('a')).task;
  const b = store.enqueue(input('b')).task;
  const c = store.enqueue(input('c', 'other')).task;
  store.update(a.id, { status: 'running' });
  const secondConnection = open();
  assert.equal(secondConnection.nextQueued().id, c.id);
  assert.throws(() => secondConnection.update(b.id, { status: 'running' }), /already running/);
  assert.equal(secondConnection.get(b.id).status, 'queued');
  store.update(a.id, { status: 'completed', result: 'Done' });
  assert.equal(secondConnection.nextQueued().id, b.id);
});

test('conversation metadata follows the last saved state even with later queued tasks and retries', (t) => {
  const open = fixture(t);
  const store = open();
  const a = store.enqueue(input('a')).task;
  store.update(a.id, { codexThreadId: 'old', worktreePath: '/work/a', branch: 'codex/a' });
  store.enqueue(input('b'));
  store.update(a.id, { codexThreadId: 'new', status: 'interrupted' });
  store.close();
  const reopened = open();
  const conversation = reopened.conversation('conversation');
  assert.equal(conversation.eventId, 'b');
  assert.equal(conversation.codexThreadId, 'new');
  assert.equal(conversation.worktreePath, '/work/a');
  const c = reopened.enqueue(input('c')).task;
  assert.equal(c.codexThreadId, 'new');
  reopened.update(c.id, { status: 'failed', error: 'safe error' });
  reopened.update(c.id, { status: 'queued', error: null });
  assert.equal(reopened.get(c.id).branch, 'codex/a');
  assert.equal(reopened.conversation('missing'), null);
});

test('outbox retry timing and delivery survive reopen', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const open = fixture(t);
  const store = open();
  const message = store.addOutbox({ botKey: 'forge', channel: 'C123', threadTs: '123.456', text: 'Done' });
  assert.equal(store.pendingOutbox().length, 1);
  store.failDelivery(message.id);
  store.close();
  const reopened = open();
  assert.equal(reopened.pendingOutbox().length, 0);
  t.mock.timers.tick(1000);
  assert.equal(reopened.pendingOutbox()[0].attempts, 1);
  reopened.failDelivery(message.id);
  t.mock.timers.tick(1999);
  assert.equal(reopened.pendingOutbox().length, 0);
  t.mock.timers.tick(1);
  reopened.markDelivered(message.id);
  reopened.failDelivery(message.id);
  assert.equal(reopened.pendingOutbox().length, 0);
  reopened.close();
  assert.equal(open().pendingOutbox().length, 0);
});

test('invalid mutations preserve task and do not leave an open transaction', (t) => {
  const store = fixture(t)();
  const task = store.enqueue(input('a')).task;
  assert.throws(() => store.update(task.id, { conversationKey: 'hijack' }), /cannot be updated/);
  assert.throws(() => store.update(task.id, { status: 'unknown' }), /Invalid task status/);
  assert.throws(() => store.update('missing', { status: 'failed' }), /not found/);
  assert.equal(store.enqueue(input('b')).created, true);
  assert.equal(store.get(task.id).status, 'queued');
});
