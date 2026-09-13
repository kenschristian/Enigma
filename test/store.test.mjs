import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store.mjs';
import { DatabaseSync } from 'node:sqlite';

test('Slack retry-after delays persist and conversation ordering does not depend on timestamps', () => {
  const store = new TaskStore(':memory:');
  const input = {eventId:'one',conversationKey:'same',role:'atlas',prompt:'work',channel:'C1',slackThreadTs:'1.1',userId:'U1',teamId:'T1',botKey:'atlas'};
  const first = store.enqueue(input).task;
  store.update(first.id,{status:'interrupted'});
  const second = store.enqueue({...input,eventId:'two'}).task;
  assert.equal(store.hasLaterActiveTask(first.id),true);
  assert.equal(store.interruptedTask('same').id,first.id);
  assert.equal(store.interruptedTask('same',first.id),null);
  store.update(second.id,{status:'cancelled'});
  assert.equal(store.hasLaterActiveTask(first.id),false);
  const message = store.addOutbox({botKey:'atlas',channel:'C1',text:'hello'});
  store.failDelivery(message.id,60000);
  assert.equal(store.pendingOutbox().length,0);
  const saved=store.db.prepare('SELECT nextAttemptAt FROM outbox WHERE id = ?').get(message.id);
  assert.ok(saved.nextAttemptAt >= Date.now()+59000);
  store.close();
});

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

test('outbox preserves destination order across failures and reopen while other destinations deliver', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const open = fixture(t);
  const store = open();
  const destination = { botKey: 'forge', channel: 'C123', threadTs: '123.456' };
  const first = store.addOutbox({ ...destination, text: 'First chunk' });
  const second = store.addOutbox({ ...destination, text: 'Second chunk' });
  const otherThread = store.addOutbox({ ...destination, threadTs: '456.789', text: 'Other thread' });
  const otherBot = store.addOutbox({ ...destination, botKey: 'atlas', text: 'Other bot' });
  const otherChannel = store.addOutbox({ ...destination, channel: 'C456', text: 'Other channel' });
  assert.deepEqual(store.pendingOutbox().map(message => message.id), [first.id, otherThread.id, otherBot.id, otherChannel.id]);
  store.failDelivery(first.id);
  store.close();
  const reopened = open();
  assert.deepEqual(reopened.pendingOutbox().map(message => message.id), [otherThread.id, otherBot.id, otherChannel.id]);
  for (const message of reopened.pendingOutbox()) reopened.markDelivered(message.id);
  assert.deepEqual(reopened.pendingOutbox(), []);
  t.mock.timers.tick(1000);
  assert.deepEqual(reopened.pendingOutbox().map(message => message.id), [first.id]);
  reopened.markDelivered(first.id);
  assert.deepEqual(reopened.pendingOutbox().map(message => message.id), [second.id]);
});

test('outbox groups messages without a Slack thread into the same destination', (t) => {
  const store = fixture(t)();
  const destination = { botKey: 'forge', channel: 'C123' };
  const first = store.addOutbox({ ...destination, text: 'First' });
  const second = store.addOutbox({ ...destination, text: 'Second' });
  assert.deepEqual(store.pendingOutbox().map(message => message.id), [first.id]);
  store.markDelivered(first.id);
  assert.deepEqual(store.pendingOutbox().map(message => message.id), [second.id]);
});

test('populated legacy outbox migrates once and preserves delivery state and new recipients across reopen', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'enigma-migrate-'));
  const path = join(root, 'tasks.db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, taskId TEXT,
    botKey TEXT NOT NULL, channel TEXT NOT NULL, threadTs TEXT, text TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, deliveredAt INTEGER, nextAttemptAt INTEGER NOT NULL
  );
  INSERT INTO outbox VALUES (7, 'pending-old', 'task-old', 'atlas', 'C123', '1.23', 'Saved pending text', 3, 100, NULL, 12345);
  INSERT INTO outbox VALUES (8, 'delivered-old', NULL, 'atlas', 'C123', NULL, 'Saved delivered text', 1, 101, 200, 0);`);
  const before = old.prepare('SELECT * FROM outbox ORDER BY sequence').all();
  old.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new TaskStore(path);
    try {
      assert.equal(store.db.prepare('PRAGMA table_info(outbox)').all().filter(column => column.name === 'notifyUserId').length, 1);
      const rows = store.db.prepare("SELECT * FROM outbox WHERE id IN ('pending-old', 'delivered-old') ORDER BY sequence").all();
      assert.deepEqual(rows.map(({ notifyUserId, ...row }) => row), before.map(row => ({ ...row })));
      assert.ok(rows.every(row => row.notifyUserId === null));
      if (attempt === 0) store.addOutbox({ botKey: 'atlas', channel: 'C456', text: 'New notice', notifyUserId: 'UOWNER' });
      else assert.equal(store.db.prepare("SELECT notifyUserId FROM outbox WHERE channel = 'C456'").get().notifyUserId, 'UOWNER');
    } finally { store.close(); }
  }
});

test('outbox only accepts null or a valid notification user ID', (t) => {
  const store = fixture(t)();
  const message = { botKey: 'atlas', channel: 'C123', text: 'Notice' };
  assert.equal(store.addOutbox(message).notifyUserId, null);
  assert.equal(store.addOutbox({ ...message, notifyUserId: 'UOWNER' }).notifyUserId, 'UOWNER');
  for (const notifyUserId of ['', 123, '<!channel>', 'UOWNER>']) {
    assert.throws(() => store.addOutbox({ ...message, notifyUserId }), /Invalid outbox notification/);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 2);
});

test('queued project identity survives reopen, deduplication, and rejects mutation or invalid input', (t) => {
  const open = fixture(t);
  const store = open();
  const projectIdentity = '["enigma","C:/repos/enigma"]';
  const task = store.enqueue({ ...input('identity'), projectIdentity }).task;
  const legacy = store.enqueue(input('legacy', 'other')).task;
  // Model a task written by the prior schema, before the optional JSON field existed.
  delete legacy.projectIdentity;
  store.db.prepare('UPDATE tasks SET data = ? WHERE id = ?').run(JSON.stringify(legacy), legacy.id);
  store.close();
  const reopened = open();
  assert.equal(reopened.get(task.id).projectIdentity, projectIdentity);
  assert.equal(reopened.nextQueued().projectIdentity, projectIdentity);
  assert.equal(reopened.get(legacy.id).projectIdentity, null);
  assert.equal(reopened.enqueue({ ...input('identity'), projectIdentity: 'different' }).task.projectIdentity, projectIdentity);
  assert.throws(() => reopened.update(task.id, { projectIdentity: 'different' }), /cannot be updated/);
  for (const projectIdentity of [null, 123, '', ' ', 'x'.repeat(1025)]) {
    assert.throws(() => reopened.enqueue({ ...input('invalid'), projectIdentity }), /Invalid task project identity/);
  }
});
