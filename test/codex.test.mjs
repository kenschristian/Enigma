import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodexClient, codexEnvironment } from '../src/codex.mjs';

const cwd = process.cwd();
const nodeExecutable = realpathSync.native(process.execPath);
const nodeDirectory = dirname(nodeExecutable);
const options = { cwd, model: 'gpt-6-astra', effort: 'ultra', prompt: 'Build it.' };
const model = { id: 'gpt-6-astra', model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }, { reasoningEffort: 'high' }] };

function harness(handler = () => false, clientOptions = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  const sent = [];
  const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const respond = (message, result) => emit({ id: message.id, result });
  const notify = (method, params) => emit({ method, params });
  let spawnOptions;
  let spawnArgs;
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      sent.push(message);
      queueMicrotask(() => {
        if (handler(message, { emit, respond, notify, child, sent })) return;
        if (message.method === 'initialize') respond(message, { userAgent: 'codex' });
        if (message.method === 'account/read') respond(message, { account: { type: 'chatgpt', email: 'private@example.com', planType: 'pro', token: 'secret' }, requiresOpenaiAuth: true });
        if (message.method === 'model/list') respond(message, { data: [model], nextCursor: null });
        if (message.method === 'config/read') respond(message, { config: { permissions: {
          enigma_workspace: { ...client.workspace.profile, extends: null, workspace_roots: null, description: null },
        } } });
        if (['thread/start', 'thread/resume'].includes(message.method)) respond(message, {
          thread: { id: message.params.threadId ?? 'thread-1' }, model: 'gpt-6-astra', modelProvider: 'openai',
          ...(message.params.permissions ? { activePermissionProfile: { id: message.params.permissions, extends: null },
            runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots } : {}),
        });
        if (message.method === 'turn/start') respond(message, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
      });
    }
    callback();
  } });
  const client = new CodexClient({ ...clientOptions, spawnFn: (_command, args, opts) => {
    spawnArgs = args; spawnOptions = opts; return child;
  } });
  return { client, child, sent, emit, respond, notify, get spawnArgs() { return spawnArgs; }, get spawnOptions() { return spawnOptions; } };
}

const finish = (notify, { threadId = 'thread-1', turnId = 'turn-1', text = 'Done.', status = 'completed' } = {}) =>
  notify('turn/completed', { threadId, turn: { id: turnId, status, items: [{ type: 'agentMessage', id: 'answer', text, phase: 'final_answer' }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Windows workspace profile applies exact read/write grants on start, resume and turn', { skip: process.platform !== 'win32' }, async t => {
  const workspace = { path: cwd, gitCommonDir: join(cwd, 'fixture-repo', '.git') };
  const h = harness((message, { respond }) => {
    if (message.method !== 'turn/start') return false;
    respond(message, { turn: { id: 'turn-1', status: 'completed', items: [] } }); return true;
  }, { workspace }); t.after(() => h.client.close());
  workspace.path = join(cwd, 'mutated');
  await h.client.run({ ...options, config: { 'agents.enabled': true } });
  await h.client.run({ ...options, threadId: 'thread-1' });
  assert.equal(h.sent[0].params.capabilities.experimentalApi, true);
  assert.equal(h.spawnOptions.cwd, cwd);
  assert.ok(h.spawnArgs.includes('default_permissions="enigma_workspace"'));
  assert.ok(h.spawnArgs.includes('windows.sandbox="elevated"'));
  assert.equal(h.spawnArgs.some(arg => /^sandbox_(mode|workspace_write)/.test(arg)), false);
  const starts = h.sent.filter(message => ['thread/start', 'thread/resume'].includes(message.method));
  for (const { params } of starts) {
    assert.equal(params.permissions, 'enigma_workspace');
    assert.deepEqual(params.runtimeWorkspaceRoots, [cwd]);
    assert.equal(params.sandbox, undefined);
    assert.equal(params.config.sandbox_mode, undefined);
    assert.deepEqual(params.config['permissions.enigma_workspace'], { filesystem: {
      ':minimal': 'read', [cwd]: 'write', [join(cwd, 'fixture-repo', '.git')]: 'read',
      [join(cwd, '.git')]: 'read', [join(cwd, '.codex')]: 'read', [join(cwd, '.agents')]: 'read',
      [nodeExecutable]: 'read',
    }, network: { enabled: false } });
    assert.equal(params.config['permissions.enigma_workspace'].filesystem[nodeDirectory], undefined);
    assert.ok(params.developerInstructions.includes(`"${nodeExecutable}" --test`));
  }
  assert.equal(starts[1].params.excludeTurns, true);
  for (const { params } of h.sent.filter(message => message.method === 'turn/start')) {
    assert.equal(params.permissions, 'enigma_workspace');
    assert.deepEqual(params.runtimeWorkspaceRoots, [cwd]);
    assert.equal(params.sandboxPolicy, undefined);
  }
});

test('Windows workspace binding rejects changed cwd and caller policy overrides before spawning', { skip: process.platform !== 'win32' }, async () => {
  const workspace = { path: cwd, gitCommonDir: join(cwd, 'repo', '.git') };
  const h = harness(undefined, { workspace });
  await assert.rejects(h.client.run({ ...options, cwd: join(cwd, 'other') }), { code: 'CODEX_PROFILE' });
  for (const key of ['permissions', 'permissions.enigma_workspace.filesystem', 'default_permissions', 'sandbox_mode',
    'sandbox_workspace_write.network_access', 'windows.sandbox', 'approval_policy', 'approvals_reviewer', 'model_provider', 'forced_login_method']) {
    await assert.rejects(h.client.run({ ...options, config: { [key]: 'unsafe' } }), { code: 'CODEX_PROFILE' });
  }
  assert.equal(h.sent.length, 0);
  assert.throws(() => harness(undefined, { workspace, cwd: join(cwd, 'other') }), TypeError);
  assert.throws(() => harness(undefined, { workspace, args: ['-c', 'sandbox_mode="danger-full-access"'] }), TypeError);
  for (const invalid of [{}, { path: 'relative', gitCommonDir: cwd }, { path: cwd, gitCommonDir: 'C:\\' }, { path: cwd, gitCommonDir: `${cwd}\n` }]) {
    assert.throws(() => harness(undefined, { workspace: invalid }), TypeError);
  }
});

test('Windows profile confirmation fails closed for absent, substituted or broadened profiles and roots', { skip: process.platform !== 'win32' }, async t => {
  for (const changes of [
    { activePermissionProfile: null }, { activePermissionProfile: { id: 'full-access', extends: null } },
    { activePermissionProfile: { id: 'enigma_workspace', extends: 'workspace' } },
    { runtimeWorkspaceRoots: [] }, { runtimeWorkspaceRoots: [cwd, join(cwd, 'other')] }, { runtimeWorkspaceRoots: [join(cwd, 'other')] },
  ]) {
    const h = harness((message, { respond }) => {
      if (!['thread/start', 'thread/resume'].includes(message.method)) return false;
      respond(message, { thread: { id: 'thread-1' }, model: 'gpt-6-astra', modelProvider: 'openai',
        activePermissionProfile: { id: 'enigma_workspace', extends: null }, runtimeWorkspaceRoots: [cwd], ...changes }); return true;
    }, { workspace: { path: cwd, gitCommonDir: join(cwd, 'repo', '.git') } }); t.after(() => h.client.close());
    await assert.rejects(h.client.run(options), { code: 'CODEX_PROFILE' });
    assert.equal(h.sent.some(message => message.method === 'turn/start'), false);
    assert.equal(h.child.killed, true);
  }
});

test('unsupported Windows profile RPC never retries with a legacy sandbox', { skip: process.platform !== 'win32' }, async t => {
  const h = harness((message, { emit }) => {
    if (message.method !== 'thread/start') return false;
    emit({ id: message.id, error: { code: -32600, message: 'Unsupported profile' } }); return true;
  }, { workspace: { path: cwd, gitCommonDir: join(cwd, 'repo', '.git') } }); t.after(() => h.client.close());
  await assert.rejects(h.client.run(options), { code: 'CODEX_RPC' });
  assert.equal(h.sent.filter(message => message.method === 'thread/start').length, 1);
  assert.equal(h.sent.some(message => message.method === 'turn/start'), false);
});

test('effective Windows profile rejects inherited roots and network access before thread creation', { skip: process.platform !== 'win32' }, async t => {
  for (const mutation of [
    profile => { profile.filesystem['C:\\private-state'] = 'read'; },
    profile => { profile.network.enabled = true; },
    profile => { profile.extends = 'workspace'; },
    profile => { profile.workspace_roots = ['C:\\']; },
    profile => { profile.filesystem[join(cwd, 'repo', '.git')] = 'write'; },
    profile => { delete profile.filesystem[nodeExecutable]; },
    profile => { profile.filesystem[nodeExecutable] = 'write'; },
    profile => { profile.filesystem[nodeDirectory] = 'read'; },
  ]) {
    const h = harness((message, { respond }) => {
      if (message.method !== 'config/read') return false;
      const profile = structuredClone(h.client.workspace.profile); mutation(profile);
      respond(message, { config: { permissions: { enigma_workspace: profile } } }); return true;
    }, { workspace: { path: cwd, gitCommonDir: join(cwd, 'repo', '.git') } }); t.after(() => h.client.close());
    await assert.rejects(h.client.run(options), { code: 'CODEX_PROFILE' });
    assert.equal(h.sent.some(message => message.method === 'thread/start'), false);
    assert.equal(h.child.killed, true);
  }
});

test('Windows child environment normalizes PATH, deduplicates names and strips credentials', () => {
  const source = { Path: 'legacy-path', PATH: 'selected-path', TEMP: 'selected-temp', temp: 'duplicate-temp', SystemRoot: 'C:\\Windows', enigma_slack_token: 'private', OpenAI_Api_Key: 'private', OPENAI_ADMIN_KEY: 'private', CODEX_API_KEY: 'private' };
  const normalized = codexEnvironment(source, 'win32');
  assert.deepEqual(normalized, { PATH: `selected-path;${nodeDirectory}`, SystemRoot: 'C:\\Windows', TEMP: 'selected-temp' });
  assert.equal(source.Path, 'legacy-path', 'the parent environment must remain unchanged');
  assert.deepEqual(codexEnvironment({ Path: 'existing-search-path' }, 'win32'), { PATH: `existing-search-path;${nodeDirectory}` });
  assert.deepEqual(codexEnvironment({}, 'win32'), { PATH: nodeDirectory });
  const existing = `system;"${nodeDirectory.toUpperCase()}";tools`;
  assert.equal(codexEnvironment({ Path: existing }, 'win32').PATH, existing);
  for (const value of [null, 123, 'prefix\0bad', 'prefix\nbad']) assert.throws(() => codexEnvironment({ PATH: value }, 'win32'), TypeError);
});

test('Windows runtime grants derive only from the validated running executable', { skip: process.platform !== 'win32' }, t => {
  const workspace = { path: cwd, gitCommonDir: join(cwd, 'repo', '.git'), nodeExecutable: 'C:\\private\\arbitrary.exe' };
  const h = harness(undefined, { workspace, nodeExecutable: 'C:\\private\\arbitrary.exe' });
  assert.equal(h.client.workspace.nodeExecutable, nodeExecutable);
  assert.equal(h.client.workspace.profile.filesystem['C:\\private\\arbitrary.exe'], undefined);
  for (const value of [cwd, 'relative.exe', join(cwd, 'missing-trusted-node.exe'), `${cwd}\nnode.exe`, `${cwd};private.exe`, `${cwd}\\%PATH%.exe`]) {
    const original = realpathSync.native;
    const mock = t.mock.method(realpathSync, 'native', () => value);
    try {
      assert.throws(() => harness(undefined, { workspace }), { code: 'CODEX_NODE_RUNTIME' });
      assert.throws(() => codexEnvironment({}, 'win32'), { code: 'CODEX_NODE_RUNTIME' });
    } finally { mock.mock.restore(); }
    assert.equal(realpathSync.native, original);
  }
});

test('a changed trusted executable fails before app-server spawn', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(undefined, { workspace: { path: cwd, gitCommonDir: join(cwd, 'repo', '.git') } });
  t.mock.method(realpathSync, 'native', () => join(cwd, 'src', 'codex.mjs'));
  await assert.rejects(h.client.start(), { code: 'CODEX_NODE_RUNTIME' });
  assert.equal(h.spawnOptions, undefined);
  assert.equal(h.sent.length, 0);
});

test('non-Windows child environment preserves case-sensitive names', () => {
  assert.deepEqual(codexEnvironment({ PATH: 'upper', Path: 'mixed', ENIGMA_TOKEN: 'private' }, 'linux'), { PATH: 'upper', Path: 'mixed' });
});

test('handshake runs once, disables shell, forces subscription auth and strips secrets', async t => {
  const previousSecret = process.env.ENIGMA_TEST_PRIVATE;
  process.env.ENIGMA_TEST_PRIVATE = 'private-test-value';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.ENIGMA_TEST_PRIVATE;
    else process.env.ENIGMA_TEST_PRIVATE = previousSecret;
  });
  const h = harness(); t.after(() => h.client.close());
  await Promise.all([h.client.start(), h.client.start()]);
  assert.deepEqual(h.sent.slice(0, 2).map(x => x.method), ['initialize', 'initialized']);
  assert.equal(h.sent[0].params.capabilities.requestAttestation, false);
  assert.equal(h.spawnOptions.shell, false);
  assert.equal(h.spawnOptions.windowsHide, true);
  assert.ok(h.spawnArgs.includes('forced_login_method="chatgpt"'));
  assert.equal(h.spawnOptions.env.OPENAI_API_KEY, undefined);
  assert.equal(h.spawnOptions.env.ENIGMA_TEST_PRIVATE, undefined);
  if (process.platform === 'win32') {
    assert.equal(Object.keys(h.spawnOptions.env).some(key => key.toUpperCase() === 'PATH' && key !== 'PATH'), false);
  }
  assert.deepEqual(await h.client.account(), { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true });
  assert.deepEqual(await h.client.models(), [model]);
});

test('model enumeration paginates and detects repeated cursors', async t => {
  let pages = 0;
  const h = harness((message, { respond }) => {
    if (message.method !== 'model/list') return false;
    pages++;
    respond(message, { data: [model], nextCursor: pages === 1 ? 'next' : null }); return true;
  }); t.after(() => h.client.close());
  assert.equal((await h.client.models()).length, 2);
  assert.equal(h.sent.find(x => x.params?.cursor)?.params.cursor, 'next');
  const bad = harness((message, { respond }) => {
    if (message.method !== 'model/list') return false;
    respond(message, { data: [], nextCursor: 'loop' }); return true;
  }); t.after(() => bad.client.close());
  await assert.rejects(bad.client.models(), { code: 'CODEX_PROTOCOL' });
});

test('saves thread before work, preserves native role config, collects final messages despite early notifications', async t => {
  let saved = false;
  const progress = [];
  const h = harness((message, { respond, notify }) => {
    if (message.method !== 'turn/start') return false;
    assert.equal(saved, true);
    notify('item/completed', { threadId: 'different', turnId: 'turn-1', item: { id: 'other', type: 'agentMessage', text: 'Wrong.' } });
    notify('item/completed', { threadId: 'thread-1', turnId: 'old', item: { id: 'old', type: 'agentMessage', text: 'Old.' } });
    notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Working.' } });
    notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'Do' });
    finish(notify);
    respond(message, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    return true;
  }); t.after(() => h.client.close());
  const result = await h.client.run({ ...options,
    config: { 'agents.enabled': true, 'agents.default_subagent_reasoning_effort': 'high', sandbox_mode: 'danger-full-access' },
    onThread: async id => { await tick(); assert.equal(id, 'thread-1'); saved = true; },
    onProgress: value => progress.push(value),
  });
  assert.deepEqual(result, { threadId: 'thread-1', turnId: 'turn-1', text: 'Done.', status: 'completed' });
  const thread = h.sent.find(x => x.method === 'thread/start').params;
  assert.equal(thread.config['agents.enabled'], true);
  assert.equal(thread.config['agents.default_subagent_reasoning_effort'], 'high');
  assert.equal(thread.config.sandbox_mode, 'workspace-write');
  assert.equal(thread.config.model_reasoning_effort, 'ultra');
  assert.equal(thread.approvalsReviewer, 'user');
  const turn = h.sent.find(x => x.method === 'turn/start').params;
  assert.equal(turn.effort, 'ultra');
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [cwd]);
  assert.deepEqual(progress, [{ type: 'working' }]);
});

test('resume reapplies explicit settings and isolates successive runs', async t => {
  let count = 0;
  const h = harness((message, { respond, notify }) => {
    if (message.method !== 'turn/start') return false;
    count++;
    respond(message, { turn: { id: `turn-${count}`, status: 'inProgress' } });
    finish(notify, { threadId: 'saved-thread', turnId: `turn-${count}`, text: `Done ${count}` }); return true;
  }); t.after(() => h.client.close());
  for (let n = 1; n <= 2; n++) assert.equal((await h.client.run({ ...options, threadId: 'saved-thread' })).text, `Done ${n}`);
  assert.equal(h.sent.filter(x => x.method === 'thread/resume').length, 2);
  assert.equal(h.sent.some(x => x.method === 'thread/start'), false);
});

test('UTF-8 and CRLF frames survive chunk boundaries', async t => {
  const h = harness((message, { child }) => {
    if (message.method !== 'turn/start') return false;
    const data = Buffer.from(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'a', text: 'All set 🌍', phase: 'final_answer' }] } } })}\r\n`);
    for (const byte of data) child.stdout.write(Buffer.from([byte])); return true;
  }); t.after(() => h.client.close());
  assert.equal((await h.client.run(options)).text, 'All set 🌍');
});

test('requires ChatGPT auth and exact model/effort without fallback', async t => {
  for (const account of [null, { type: 'apiKey' }, { type: 'amazonBedrock' }]) {
    const h = harness((message, { respond }) => {
      if (message.method !== 'account/read') return false;
      respond(message, { account }); return true;
    }); t.after(() => h.client.close());
    await assert.rejects(h.client.run(options), { code: 'CODEX_AUTH' });
    assert.equal(h.sent.some(x => x.method === 'thread/start'), false);
  }
  for (const override of [{ model: 'another-model' }, { effort: 'max' }]) {
    const h = harness(); t.after(() => h.client.close());
    await assert.rejects(h.client.run({ ...options, ...override }), { code: 'CODEX_MODEL' });
    assert.equal(h.sent.some(x => x.method === 'turn/start'), false);
  }
});

test('rejects model substitution returned by server before turn starts', async t => {
  const h = harness((message, { respond }) => {
    if (message.method !== 'thread/start') return false;
    respond(message, { thread: { id: 'thread-1' }, model: 'different', modelProvider: 'openai' }); return true;
  }); t.after(() => h.client.close());
  await assert.rejects(h.client.run(options), { code: 'CODEX_PROTOCOL' });
  assert.equal(h.sent.some(x => x.method === 'turn/start'), false);
});

test('all server approval, tool, input and unknown requests fail closed with safe callbacks', async t => {
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval', 'item/tool/requestUserInput', 'item/tool/call',
    'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval',
    'account/chatgptAuthTokens/refresh', 'secret-unknown-method'];
  const approvals = [];
  const h = harness((message, { respond, emit, notify }) => {
    if (message.method !== 'turn/start') return false;
    respond(message, { turn: { id: 'turn-1', status: 'inProgress' } });
    methods.forEach((method, index) => emit({ id: `server-${index}`, method, params: { reason: 'private secret', command: 'sensitive' } }));
    finish(notify); return true;
  }); t.after(() => h.client.close());
  await h.client.run({ ...options, onApproval: value => approvals.push(value) });
  const replies = h.sent.filter(x => String(x.id).startsWith('server-'));
  assert.equal(replies.length, methods.length);
  assert.deepEqual(replies[0].result, { decision: 'decline' });
  assert.deepEqual(replies[2].result, { permissions: {}, scope: 'turn' });
  assert.deepEqual(replies[3].result, { answers: {} });
  assert.equal(replies[4].result.success, false);
  assert.equal(replies[5].result.action, 'decline');
  assert.equal(replies[6].result.decision, 'abort');
  assert.equal(replies[8].error.code, -32601);
  assert.equal(approvals.length, methods.length);
  assert.equal(JSON.stringify(approvals).includes('secret'), false);
});

test('cancellation interrupts and kills active work; parallel run is rejected', async t => {
  const h = harness(); t.after(() => h.client.close());
  const controller = new AbortController();
  const result = h.client.run({ ...options, signal: controller.signal });
  await tick();
  await assert.rejects(h.client.run(options), { code: 'CODEX_BUSY' });
  controller.abort(new Error('private reason'));
  await assert.rejects(result, { code: 'CODEX_CANCELLED', message: 'Codex task was cancelled.' });
  assert.ok(h.sent.some(x => x.method === 'turn/interrupt'));
  assert.equal(h.child.killed, true);
});

test('timeout during persistence callback prevents model work and rejects promptly', async t => {
  const h = harness(); t.after(() => h.client.close());
  await assert.rejects(h.client.run({ ...options, timeoutMs: 20, onThread: () => new Promise(() => {}) }), { code: 'CODEX_TIMEOUT' });
  assert.equal(h.sent.some(x => x.method === 'turn/start'), false);
  assert.equal(h.child.killed, true);
});

test('pre-aborted and invalid runs never start a process', async () => {
  const h = harness();
  await assert.rejects(h.client.run({ ...options, signal: AbortSignal.abort() }), { code: 'CODEX_CANCELLED' });
  await assert.rejects(h.client.run({ ...options, cwd: 'relative' }), TypeError);
  assert.equal(h.sent.length, 0);
});

test('persistence failure is sanitized and prevents turn/start', async t => {
  const h = harness(); t.after(() => h.client.close());
  await assert.rejects(h.client.run({ ...options, onThread: () => { throw new Error('secret'); } }), { code: 'CODEX_PERSIST' });
  assert.equal(h.sent.some(x => x.method === 'turn/start'), false);
});

test('malformed input, oversized frames, process exit and IO failure reject active operations safely', async t => {
  for (const [trigger, code] of [
    [h => h.child.stdout.write('not json secret\n'), 'CODEX_PROTOCOL'],
    [h => h.child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)), 'CODEX_PROTOCOL'],
    [h => h.emit([]), 'CODEX_PROTOCOL'],
    [h => h.child.emit('exit', 1), 'CODEX_EXIT'],
    [h => h.child.stdin.emit('error', new Error('secret')), 'CODEX_IO'],
  ]) {
    const h = harness(); t.after(() => h.client.close());
    const result = h.client.run(options);
    await tick(); trigger(h);
    await assert.rejects(result, error => error.code === code && !error.message.includes('secret'));
    assert.equal(h.child.killed, true);
  }
});

test('RPC error contents are not exposed; request timeout closes transport', async t => {
  const h = harness((message, { emit }) => {
    if (message.method !== 'account/read') return false;
    emit({ id: message.id, error: { code: 42, message: 'secret', data: { token: 'secret' } } }); return true;
  }); t.after(() => h.client.close());
  await assert.rejects(h.client.account(), error => error.code === 'CODEX_RPC' && !error.message.includes('secret'));
  const stuck = harness(message => message.method === 'initialize', { requestTimeoutMs: 10 });
  await assert.rejects(stuck.client.start(), { code: 'CODEX_RPC_TIMEOUT' });
  assert.equal(stuck.child.killed, true);
});

test('failed/interrupted turn statuses return without leaking raw error payloads', async t => {
  for (const status of ['failed', 'interrupted']) {
    const h = harness((message, { respond }) => {
      if (message.method !== 'turn/start') return false;
      respond(message, { turn: { id: 'turn-1', status, items: [], error: { message: 'secret' } } }); return true;
    }); t.after(() => h.client.close());
    assert.deepEqual(await h.client.run(options), { threadId: 'thread-1', turnId: 'turn-1', text: '', status });
  }
});

test('close awaits delayed child exit after cancellation before releasing the caller', async () => {
  const h = harness();
  h.child.kill = () => { h.child.killed = true; };
  const result = h.client.run(options);
  await tick();
  const cancelled = assert.rejects(result, { code: 'CODEX_CLOSED' });
  let closed = false;
  const cleanup = h.client.close().then(() => { closed = true; });
  await cancelled;
  await tick();
  assert.equal(h.child.killed, true);
  assert.equal(closed, false);
  assert.ok(h.sent.some(x => x.method === 'turn/interrupt'));
  h.child.emit('exit', 0);
  await cleanup;
  assert.equal(closed, true);
  await h.client.close();
});

test('close reports CODEX_SHUTDOWN when child exit cannot be confirmed within five seconds', async t => {
  const h = harness();
  h.child.kill = () => { h.child.killed = true; };
  await h.client.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleanup = assert.rejects(h.client.close(), { code: 'CODEX_SHUTDOWN' });
  t.mock.timers.tick(5000);
  await cleanup;
  h.child.emit('exit', 0);
  await h.client.close();
});
