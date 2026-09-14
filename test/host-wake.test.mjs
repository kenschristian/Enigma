import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { enqueueHostWake } from '../src/host-wake.mjs';

const threadId = '01a09cc2-34a3-74c0-9399-4d32c67f40a2';
const eventId = '01a09da7-df09-7d21-957e-ab204aca3ca1';
const queuedId = '01a09da7-df0b-7423-93c5-07547680e41c';
const options = { command: 'codex.exe', threadId, eventId, message: 'Process the saved authorized event.' };
const submission = (extra = {}) => ({ id: queuedId, clientUserMessageId: eventId,
  input: [{ type: 'text', text: options.message }], ...extra });
function harness(handler = () => false, deps = {}) {
  const child = new EventEmitter(), sent = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  const emit = data => child.stdout.write(`${JSON.stringify(data)}\n`);
  const respond = (request, result) => emit({ id: request.id, result });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line); sent.push(request);
      queueMicrotask(() => {
        if (handler(request, { child, emit, respond, sent })) return;
        if (request.method === 'initialize') respond(request, {});
        if (request.method === 'account/read') respond(request, { account: { type: 'chatgpt' } });
        if (request.method === 'thread/queue/list') respond(request, { data: [], nextCursor: null });
        if (request.method === 'thread/queue/add') respond(request, { queuedSubmission: submission() });
      });
    }
    done();
  } });
  const h = { child, sent, run: (overrides = {}) => enqueueHostWake({ ...options, ...overrides }, {
    requestTimeoutMs: 25, timeoutMs: 200, ...deps,
    spawnFn: (command, args, spawnOptions) => {
      Object.assign(h, { command, args, spawnOptions }); return child;
    },
  }) };
  return h;
}

test('queues one stable event to the fixed target without starting or changing a thread', async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { status: 'queued', queuedSubmissionId: queuedId });
  assert.deepEqual(h.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(h.spawnOptions.shell, false); assert.equal(h.spawnOptions.windowsHide, true);
  assert.deepEqual(h.sent.map(x => x.method), ['initialize', 'initialized', 'account/read', 'thread/queue/list', 'thread/queue/add']);
  const add = h.sent.at(-1).params;
  assert.equal(add.threadId, threadId); assert.equal(add.clientUserMessageId, eventId);
  assert.equal(h.child.killed, true); assert.equal(h.child.stdin.writableEnded, true);
});

test('reuses an existing stable event after bounded queue pagination', async () => {
  const h = harness((request, { respond }) => {
    if (request.method !== 'thread/queue/list') return false;
    respond(request, request.params.cursor ? { data: [submission()], nextCursor: null } : { data: [], nextCursor: 'page-two' });
    return true;
  });
  assert.deepEqual(await h.run({ reconcileOnly: true }), { status: 'queued', queuedSubmissionId: queuedId });
  assert.equal(h.sent.filter(x => x.method === 'thread/queue/list').length, 2);
  assert.equal(h.sent.some(x => x.method === 'thread/queue/add'), false);
});

test('missing reconciliation result never adds an event that may already have been consumed', async () => {
  const h = harness();
  assert.deepEqual(await h.run({ reconcileOnly: true }), { status: 'uncertain' });
  assert.equal(h.sent.some(x => x.method === 'thread/queue/add'), false);
});

test('ordinary desktop client message IDs do not block a new wake or reconciliation', async () => {
  for (const clientUserMessageId of ['desktop-message-42', '']) {
    const h = harness((request, { respond }) => {
      if (request.method !== 'thread/queue/list') return false;
      respond(request, { data: [submission({ id: threadId, clientUserMessageId })] }); return true;
    });
    assert.deepEqual(await h.run(), { status: 'queued', queuedSubmissionId: queuedId });
    assert.equal(h.sent.filter(x => x.method === 'thread/queue/add').length, 1);
    const reconciliation = harness((request, { respond }) => {
      if (request.method !== 'thread/queue/list') return false;
      respond(request, { data: [submission({ id: threadId, clientUserMessageId }), submission()] }); return true;
    });
    assert.deepEqual(await reconciliation.run({ reconcileOnly: true }), { status: 'queued', queuedSubmissionId: queuedId });
    assert.equal(reconciliation.sent.some(x => x.method === 'thread/queue/add'), false);
  }
});

test('lost add response is recovered by listing, with no repeated add', async () => {
  let added = false;
  const h = harness((request, { respond }) => {
    if (request.method === 'thread/queue/add') { added = true; return true; }
    if (request.method === 'thread/queue/list' && added) { respond(request, { data: [submission()] }); return true; }
    return false;
  });
  assert.deepEqual(await h.run(), { status: 'queued', queuedSubmissionId: queuedId });
  assert.equal(h.sent.filter(x => x.method === 'thread/queue/add').length, 1);
});

test('lost add response followed by consumption remains uncertain', async () => {
  const h = harness(request => request.method === 'thread/queue/add');
  assert.deepEqual(await h.run(), { status: 'uncertain' });
  assert.equal(h.sent.filter(x => x.method === 'thread/queue/add').length, 1);
});

test('rejects duplicate client IDs, malformed queue IDs, and cycling pagination', async t => {
  for (const [name, result] of [
    ['duplicate event', { data: [submission(), submission({ id: threadId })] }],
    ['invalid ID', { data: [submission({ id: 'wrong' })] }],
    ['null client message ID', { data: [submission({ clientUserMessageId: null })] }],
    ['duplicate queue ID', { data: [submission(), submission({ clientUserMessageId: threadId })] }],
    ['pagination cycle', { data: [], nextCursor: 'same' }],
    ['invalid page', { data: {} }],
  ]) await t.test(name, async () => {
    const h = harness((request, { respond }) => {
      if (request.method !== 'thread/queue/list') return false;
      respond(request, result); return true;
    });
    assert.deepEqual(await h.run(), { status: 'uncertain' });
    assert.equal(h.sent.some(x => x.method === 'thread/queue/add'), false);
  });
});

test('mismatched add response is never accepted as the event acknowledgement', async () => {
  const h = harness((request, { respond }) => {
    if (request.method !== 'thread/queue/add') return false;
    respond(request, { queuedSubmission: submission({ clientUserMessageId: threadId }) }); return true;
  });
  assert.deepEqual(await h.run(), { status: 'uncertain' });
  assert.equal(h.sent.filter(x => x.method === 'thread/queue/add').length, 1);
});

test('timeouts and malformed RPC stop safely and close the child', async t => {
  for (const [name, handler] of [
    ['timeout', request => request.method === 'initialize'],
    ['invalid JSON', (request, { child }) => { if (request.method !== 'initialize') return false; child.stdout.write('bad\n'); return true; }],
    ['wrong response ID', (request, { emit }) => { if (request.method !== 'initialize') return false; emit({ id: 9999, result: {} }); return true; }],
    ['frame bound', (request, { child }) => { if (request.method !== 'initialize') return false; child.stdout.write('x'.repeat(256 * 1024 + 1)); return true; }],
    ['approval request', (request, { emit }) => { if (request.method !== 'initialize') return false; emit({ id: 'server', method: 'item/commandExecution/requestApproval', params: {} }); return true; }],
    ['process exit', (request, { child }) => { if (request.method !== 'initialize') return false; child.emit('exit', 1); return true; }],
  ]) await t.test(name, async () => {
    const h = harness(handler);
    assert.deepEqual(await h.run(), { status: 'uncertain' });
    assert.equal(h.child.killed, true);
    assert.equal(h.sent.some(x => x.method === 'thread/queue/add'), false);
  });
});

test('spawn and server errors cannot expose their raw contents', async () => {
  assert.deepEqual(await enqueueHostWake(options, { spawnFn: () => { throw new Error('secret'); } }), { status: 'uncertain' });
  const h = harness((request, { emit }) => {
    if (request.method !== 'initialize') return false;
    emit({ id: request.id, error: { code: 1, message: 'secret', data: { token: 'private' } } }); return true;
  });
  assert.deepEqual(await h.run(), { status: 'uncertain' });
});

test('requires ChatGPT authentication and strips bridge and provider credentials', async () => {
  const keys = ['ENIGMA_TEST_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
  const before = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'private-test-value';
    const h = harness((request, { respond }) => {
      if (request.method !== 'account/read') return false;
      respond(request, { account: { type: 'apiKey' } }); return true;
    });
    assert.deepEqual(await h.run(), { status: 'uncertain' });
    for (const key of keys) assert.equal(h.spawnOptions.env[key], undefined);
    assert.equal(h.sent.some(x => x.method.startsWith('thread/')), false);
  } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
});

test('invalid configured target, event, or prompt cannot spawn a process', async () => {
  for (const invalid of [{ threadId: 'a session name' }, { eventId: 'wrong' }, { message: '' }, { message: 'x'.repeat(16385) }]) {
    await assert.rejects(enqueueHostWake({ ...options, ...invalid }, { spawnFn: () => assert.fail('must not spawn') }), /Invalid host wake options/);
  }
});

test('login flow names and unrelated providers are not accepted as ChatGPT account types', async () => {
  for (const type of ['chatgptAuthTokens', 'amazonBedrock', 'unknown']) {
    const h = harness((request, { respond }) => {
      if (request.method !== 'account/read') return false;
      respond(request, { account: { type } }); return true;
    });
    assert.deepEqual(await h.run(), { status: 'uncertain' });
    assert.equal(h.sent.some(x => x.method.startsWith('thread/')), false);
  }
});
