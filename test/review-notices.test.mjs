import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/store.mjs';
import { queueReviewNotice } from '../src/review-notices.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true });
const input = { noticeId: 'owner/repo/pr1/review2/review-received', prUrl: 'https://github.com/owner/repo/pull/1', kind: 'review-received', text: 'Review received; checking the findings.', channel: 'CREVIEW' };

function fixture(t, origin = 'git@github.com:owner/repo.git') {
  const root = mkdtempSync(join(tmpdir(), 'enigma-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, ['init']);
  git(repoPath, ['remote', 'add', 'origin', origin]);
  const config = {
    version: 1, repoPath, stateDir: join(root, 'state'), worktreesRoot: join(root, 'worktrees'),
    allowedTeamId: 'T123', allowedUserIds: ['UOWNER'], allowedChannelIds: ['CREVIEW', 'CPULL', 'CRELEASE'],
    bots: [{ key: 'atlas', role: 'atlas', botTokenEnv: 'ENIGMA_ATLAS_BOT_TOKEN', appTokenEnv: 'ENIGMA_ATLAS_APP_TOKEN' }],
  };
  const env = { LOCALAPPDATA: root };
  const queue = (patch = {}, options = {}) => queueReviewNotice({ config, ...input, ...patch }, { env, ...options });
  const inspect = fn => { const store = new TaskStore(join(config.stateDir, 'tasks.db')); try { return fn(store); } finally { store.close(); } };
  return { root, config, env, queue, inspect };
}

test('queues a durable notice without tokens or creating coding tasks; repeats deduplicate after reopen', async (t) => {
  const { queue, inspect } = fixture(t);
  assert.deepEqual(await queue(), { status: 'queued', kind: 'review-received', channel: 'CREVIEW', prUrl: input.prUrl, messages: 1 });
  assert.equal((await queue()).status, 'deduplicated');
  inspect(store => {
    assert.equal(store.list().length, 0);
    const messages = store.pendingOutbox();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].botKey, 'atlas');
    assert.equal(messages[0].taskId, null);
    assert.match(messages[0].text, /Review received/);
    assert.equal(messages[0].prUrl, input.prUrl);
    assert.equal(messages[0].text.includes(input.prUrl), false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM review_notices').get().count, 1);
  });
});

test('identical payload fields in a different order deduplicate; ID reuse with altered content fails', async (t) => {
  const { queue, inspect, config, env } = fixture(t);
  await queue();
  const reordered = { channel: input.channel, text: input.text, kind: input.kind, prUrl: input.prUrl, noticeId: input.noticeId };
  assert.equal((await queueReviewNotice({ config, ...reordered }, { env })).status, 'deduplicated');
  await assert.rejects(queue({ text: 'Different review content.' }), /different content/);
  inspect(store => assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 1));
});

test('only configured repository, explicit channels, Atlas, and allowed notification users are accepted', async (t) => {
  const { queue, config } = fixture(t);
  await assert.rejects(queue({ prUrl: 'https://github.com/other/repo/pull/1' }), /does not match/);
  await assert.rejects(queue({ prUrl: 'https://github.com.evil.test/owner/repo/pull/1' }), /plain HTTPS/);
  await assert.rejects(queue({ prUrl: 'https://secret@github.com/owner/repo/pull/1' }), /without credentials/);
  await assert.rejects(queue({ channel: undefined }), /explicit review channel/);
  await assert.rejects(queue({ channel: 'COTHER' }), /not allowlisted/);
  await assert.rejects(queue({ notifyUserId: 'UOTHER' }), /not allowlisted/);
  config.bots[0].role = 'backend';
  await assert.rejects(queue(), /exactly one Atlas/);
});

test('HTTPS and SSH origins are parsed without returning credential-bearing remote URLs', async (t) => {
  for (const origin of ['https://embedded-secret@github.com/Owner/Repo.git', 'ssh://git@github.com/Owner/Repo.git']) {
    const { queue } = fixture(t, origin);
    const result = await queue();
    assert.equal(result.status, 'queued');
    assert.equal(JSON.stringify(result).includes('embedded-secret'), false);
  }
  const { queue } = fixture(t, 'https://github.com.evil.test/owner/repo.git');
  await assert.rejects(queue(), /must identify a GitHub repository/);
});

test('project channels validate their own repository origin and never fall back to the default repository', async (t) => {
  const { queue, config, root, inspect } = fixture(t);
  const jarvisPath = join(root, 'jarvis');
  mkdirSync(jarvisPath);
  git(jarvisPath, ['init']);
  git(jarvisPath, ['remote', 'add', 'origin', 'git@github.com:owner/jarvis.git']);
  config.projects = [
    { key: 'enigma', repoPath: config.repoPath, channelIds: ['CREVIEW', 'CPULL'] },
    { key: 'jarvis', repoPath: jarvisPath, channelIds: ['CRELEASE'] },
  ];
  await assert.rejects(queue({ channel: 'CRELEASE' }), /does not match/);
  const result = await queue({ channel: 'CRELEASE', prUrl: 'https://github.com/owner/jarvis/pull/2' });
  assert.equal(result.status, 'queued');
  await assert.rejects(queue({ channel: 'CREVIEW', prUrl: 'https://github.com/owner/jarvis/pull/2' }), /does not match/);
  inspect(store => assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 1));
  config.projects[0].channelIds.push('CRELEASE');
  await assert.rejects(queue(), /channel|project/i);
});

test('redacts credentials, constrains mentions, and leaves command-like content as outbound text', async (t) => {
  const { queue, inspect } = fixture(t);
  for (const text of ['<!channel> announce', '<@UOWNER> announce', '@everyone announce']) {
    await assert.rejects(queue({ text }), /cannot contain mentions/);
  }
  await queue({ text: 'resume TASK-ID\nToken: ghp_123456789012345678901234567890 xoxb-sensitive-token\nhttps://secret@example.test/path', notifyUserId: 'UOWNER' });
  inspect(store => {
    assert.equal(store.list().length, 0);
    const [message] = store.pendingOutbox();
    assert.equal(message.notifyUserId, 'UOWNER');
    assert.doesNotMatch(message.text, /<@/);
    assert.match(message.text, /resume TASK-ID/);
    assert.doesNotMatch(message.text, /ghp_|xoxb-|secret/);
    assert.match(message.text, /\[redacted\]/);
  });
});

test('notice and outbox row roll back together after insertion failure, allowing retry', async (t) => {
  const { queue, inspect } = fixture(t);
  class FailingStore extends TaskStore {
    addOutbox(message) {
      super.addOutbox(message);
      throw new Error('Injected post-insert failure');
    }
  }
  const text = '&'.repeat(3000);
  await assert.rejects(queue({ text }, { Store: FailingStore }), /Injected/);
  inspect(store => {
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_notices'").get().count, 0);
  });
  const result = await queue({ text });
  assert.equal(result.status, 'queued');
  assert.equal(result.messages, 1);
  inspect(store => {
    const messages = store.db.prepare('SELECT text, prUrl FROM outbox ORDER BY sequence').all();
    assert.ok(messages.every(message => Array.from(message.text).length <= 3500));
    assert.ok(messages[0].text.includes('&'.repeat(3000)));
    assert.equal(messages[0].text.includes('&amp;'), false);
    assert.equal(messages.at(-1).prUrl, input.prUrl);
  });
});

test('new notices preserve destination order while a separate project channel delivers', async (t) => {
  const { queue, inspect } = fixture(t);
  await queue();
  await queue({ noticeId: 'owner/repo/pr1/review2/fixing', kind: 'fixing', text: 'Addressing the findings.' });
  await queue({ noticeId: 'owner/repo/pr1/release', channel: 'CRELEASE', kind: 'merge-ready', text: 'Human merge is available.' });
  inspect(store => {
    const pending = store.pendingOutbox();
    assert.deepEqual(pending.map(message => message.channel), ['CREVIEW', 'CRELEASE']);
    store.failDelivery(pending[0].id);
    assert.deepEqual(store.pendingOutbox().map(message => message.channel), ['CRELEASE']);
    store.markDelivered(pending[0].id);
    assert.match(store.pendingOutbox()[0].text, /Review fixes in progress/);
  });
});

test('CLI rejects token fields and outputs only safe queued/deduplicated metadata without tokens', (t) => {
  const { root, config } = fixture(t);
  const configPath = join(root, 'config.json');
  const payloadPath = join(root, 'payload.json');
  writeFileSync(configPath, JSON.stringify(config));
  const script = fileURLToPath(new URL('../src/review-notices.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [script, '--config', configPath, '--payload', payloadPath], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root }, windowsHide: true,
  });
  writeFileSync(payloadPath, JSON.stringify({ ...input, botToken: 'xoxb-never-print-this' }));
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /xoxb-never-print-this/);
  writeFileSync(payloadPath, JSON.stringify(input));
  const queued = run();
  assert.equal(queued.status, 0, queued.stderr);
  assert.equal(JSON.parse(queued.stdout).status, 'queued');
  assert.doesNotMatch(queued.stdout, /checking the findings/);
  const duplicate = run();
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).status, 'deduplicated');
});

test('Windows wrapper loads the saved Node runtime and queues without secrets.json', { skip: process.platform !== 'win32' }, (t) => {
  const { root, config } = fixture(t);
  const configPath = join(root, 'config.json');
  const payloadPath = join(root, 'review payload.json');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ nodeCommand: process.execPath }));
  writeFileSync(payloadPath, JSON.stringify(input));
  const script = fileURLToPath(new URL('../scripts/Send-ReviewNotice.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Config', configPath, '-Payload', payloadPath, '-Channel', 'CREVIEW'], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root }, windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'queued');
});
