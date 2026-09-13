import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TaskStore } from './store.mjs';
import { defaultConfigPath, loadConfig, validateConfig, redact } from './config.mjs';
import { splitMessage } from './slack.mjs';
import { resolveProject } from './projects.mjs';

const execute = promisify(execFile);
const labels = Object.freeze({
  'pr-ready': 'Pull request ready for review',
  'review-received': 'Review received',
  fixing: 'Review fixes in progress',
  blocked: 'Review follow-up blocked',
  'merge-ready': 'Review findings resolved; required checks passed. Ready for your Merge click.',
  merged: 'Pull request merged',
  update: 'Project update',
});
const fields = new Set(['noticeId', 'prUrl', 'kind', 'text', 'channel', 'notifyUserId']);
class NoticeError extends Error {}
const fail = message => { throw new NoticeError(message); };
const digest = value => createHash('sha256').update(value).digest('hex');

function redactNotice(text, env) {
  return redact(text, env)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\b(?:Bearer|token)\s+[A-Za-z0-9_.-]{16,}\b/gi, '[redacted]');
}

function pullRequest(value) {
  if (typeof value !== 'string' || value.length > 250) fail('Supply a GitHub pull request URL.');
  let url;
  try { url = new URL(value); } catch { fail('Supply a GitHub pull request URL.'); }
  const match = url.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,19})\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match) {
    fail('Supply a plain HTTPS GitHub pull request URL without credentials or query parameters.');
  }
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { repo, url: `https://github.com/${repo}/pull/${match[3]}` };
}

function originRepository(value) {
  let pathname;
  const scp = value.match(/^git@github\.com:([A-Za-z0-9_.\/-]+)$/i);
  if (scp) pathname = `/${scp[1]}`;
  else {
    let url;
    try { url = new URL(value); } catch { fail('Configured origin must identify a GitHub repository.'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'github.com' || url.search || url.hash ||
        (url.port && !(url.protocol === 'ssh:' && url.port === '22'))) fail('Configured origin must identify a GitHub repository.');
    pathname = url.pathname;
  }
  const match = pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)\/?$/);
  if (!match) fail('Configured origin must identify a GitHub repository.');
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`.toLowerCase();
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !fields.has(key))) {
    fail('Review notice contains unsupported fields.');
  }
  if (typeof payload.noticeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:#-]{0,255}$/.test(payload.noticeId)) {
    fail('Supply a stable notice ID of at most 256 characters.');
  }
  if (!Object.hasOwn(labels, payload.kind)) fail('Unsupported review notice kind.');
  if (typeof payload.text !== 'string' || !payload.text.trim() || Array.from(payload.text).length > 3000) {
    fail('Review notice text must contain 1 to 3000 characters.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.text) ||
      /<[@!]|@(channel|here|everyone)\b/i.test(payload.text)) fail('Review notice text cannot contain mentions or control characters.');
  if (typeof payload.channel !== 'string' || !/^[CG][A-Z0-9]+$/.test(payload.channel)) fail('Supply an explicit review channel ID.');
}

// This helper queues outbound notices only. It never receives Slack commands,
// enqueues coding tasks, decrypts credentials, or contacts GitHub/OpenAI/Slack.
export async function queueReviewNotice({ config, ...payload }, { env = process.env, Store = TaskStore } = {}) {
  validatePayload(payload);
  const settings = validateConfig(config, { env, requireTokens: false });
  if (!settings.allowedChannelIds.includes(payload.channel)) fail('Review channel is not allowlisted.');
  const project = resolveProject(settings, payload.channel);
  if (payload.notifyUserId !== undefined && (typeof payload.notifyUserId !== 'string' || !settings.allowedUserIds.includes(payload.notifyUserId))) {
    fail('Notification user is not allowlisted.');
  }
  const atlasBots = settings.bots.filter(bot => bot.role === 'atlas');
  if (atlasBots.length !== 1) fail('Configure exactly one Atlas bot for review notices.');
  if (redactNotice(payload.noticeId, env) !== payload.noticeId) fail('Notice IDs cannot contain credentials.');
  const pr = pullRequest(payload.prUrl);
  let origin;
  try {
    const result = await execute('git', ['remote', 'get-url', 'origin'], {
      cwd: project.repoPath, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384,
    });
    origin = result.stdout.trim();
  } catch { fail('Cannot verify the configured repository origin.'); }
  if (originRepository(origin) !== pr.repo) fail('Pull request repository does not match configured origin.');
  const botKey = atlasBots[0].key;
  const text = redactNotice(payload.text.trim(), env);
  const messages = splitMessage(`${labels[payload.kind]}\n\n${text}\n\n${pr.url}`);
  const fingerprint = digest(JSON.stringify({
    noticeId: payload.noticeId, prUrl: pr.url, kind: payload.kind, text: payload.text,
    channel: payload.channel, notifyUserId: payload.notifyUserId ?? null, botKey, teamId: settings.allowedTeamId, projectKey: project.key,
  }));
  const store = new Store(join(settings.stateDir, 'tasks.db'));
  try {
    return store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS review_notices (
        notice_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        message_ids TEXT NOT NULL
      )`);
      const previous = store.db.prepare('SELECT fingerprint, message_ids FROM review_notices WHERE notice_id = ?').get(payload.noticeId);
      const summary = { kind: payload.kind, channel: payload.channel, prUrl: pr.url };
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('Notice ID already exists with different content.');
        return { status: 'deduplicated', ...summary, messages: JSON.parse(previous.message_ids).length };
      }
      const ids = messages.map((text, index) => store.addOutbox({
        botKey, channel: payload.channel, text, notifyUserId: index === 0 ? payload.notifyUserId ?? null : null,
      }).id);
      store.db.prepare('INSERT INTO review_notices (notice_id, fingerprint, created_at, message_ids) VALUES (?, ?, ?, ?)')
        .run(payload.noticeId, fingerprint, Date.now(), JSON.stringify(ids));
      return { status: 'queued', ...summary, messages: ids.length };
    });
  } finally { store.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--payload', '--channel'].includes(args[i]) || !args[i + 1] || options.has(args[i])) fail('Use --payload FILE with optional --config FILE and --channel ID.');
    options.set(args[i], args[i + 1]);
  }
  if (!options.has('--payload')) fail('Supply a review notice JSON payload file.');
  let payload;
  try {
    if (statSync(options.get('--payload')).size > 32768) fail('Review notice payload is too large.');
    payload = JSON.parse(readFileSync(options.get('--payload'), 'utf8').replace(/^\uFEFF/, ''));
  } catch { fail('Review notice payload is unreadable or invalid.'); }
  if (options.has('--channel')) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Review notice payload must be an object.');
    if (payload.channel !== undefined && payload.channel !== options.get('--channel')) fail('Payload and command channel IDs do not match.');
    payload.channel = options.get('--channel');
  }
  validatePayload(payload);
  const config = loadConfig(options.get('--config') || defaultConfigPath(), { requireTokens: false });
  const result = await queueReviewNotice({ config, ...payload });
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'error', message: error instanceof NoticeError ? error.message : 'Review notice could not be queued; check configuration and local state access.' }));
    process.exitCode = 1;
  });
}
