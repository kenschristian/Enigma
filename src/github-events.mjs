import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

const API = 'https://api.github.com';
const GREPTILE_APP = 867647;
const GREPTILE_BOT = 165735046;
const PAGE_SIZE = 100;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const failure = () => new Error('GitHub observation failed; verify repository access and try again');

function gitEnvironment() {
  // Only OS/runtime paths needed to locate Git and its existing credential store.
  // No bridge/provider secrets, process preload flags, or inherited Git overrides.
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir',
    'userprofile', 'homedrive', 'homepath', 'home', 'appdata', 'localappdata', 'programdata',
    'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)',
    'commonprogramw6432', 'xdg_config_home', 'lang', 'lc_all']);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
}

function target(input) {
  if (!input || typeof input.repository !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
      ['.', '..'].includes(input.repository.split('/')[1]) || !positive(input.pullRequest) ||
      typeof input.repoPath !== 'string' || !isAbsolute(input.repoPath) || /[\0\r\n]/.test(input.repoPath) ||
      (input.reviewRecorded !== undefined && typeof input.reviewRecorded !== 'boolean')) throw failure();
  return { repository: input.repository.toLowerCase(), pullRequest: input.pullRequest, repoPath: input.repoPath,
    reviewRecorded: input.reviewRecorded === true };
}

// Shell-free, bounded subprocesses; errors deliberately discard stdout/stderr.
function runGit(args, options) {
  return new Promise((resolve, reject) => {
    const { input, ...execOptions } = options;
    const child = execFile('git', args, execOptions, (error, stdout) => error ? reject(failure()) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

function originRepository(origin) {
  const value = origin.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  return match?.[1].toLowerCase();
}

/** Read-only GitHub transport. Dependency injection is for trusted host tests only. */
export class GitHubReadClient {
  #runGit;
  #fetch;
  #timeout;
  #maxPages;
  #maxBody;

  constructor({ runGit: git = runGit, fetch: fetcher = globalThis.fetch, timeoutMs = 10_000, maxPages = 10, maxBodyBytes = 2 * 1024 * 1024 } = {}) {
    if (typeof git !== 'function' || typeof fetcher !== 'function' || !positive(timeoutMs) || timeoutMs > 30_000 ||
        !positive(maxPages) || maxPages > 20 || !positive(maxBodyBytes) || maxBodyBytes > 4 * 1024 * 1024) throw failure();
    this.#runGit = git;
    this.#fetch = fetcher;
    this.#timeout = timeoutMs;
    this.#maxPages = maxPages;
    this.#maxBody = maxBodyBytes;
  }

  async #credential({ repository, repoPath }) {
    const options = { cwd: repoPath, windowsHide: true, encoding: 'utf8', timeout: this.#timeout, maxBuffer: 64 * 1024,
      env: gitEnvironment() };
    const origin = await this.#runGit(['remote', 'get-url', 'origin'], options);
    if (typeof origin !== 'string' || originRepository(origin) !== repository) throw failure();
    const output = await this.#runGit(['credential', 'fill'], { ...options, input: 'protocol=https\nhost=github.com\n\n' });
    if (typeof output !== 'string' || output.length > 64 * 1024) throw failure();
    const fields = new Map();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const index = line.indexOf('=');
      if (index < 1 || fields.has(line.slice(0, index))) throw failure();
      fields.set(line.slice(0, index), line.slice(index + 1));
    }
    const token = fields.get('password');
    if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com' ||
        typeof token !== 'string' || !token.length || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw failure();
    return token;
  }

  async #get(path, token) {
    // Callers construct paths from validated repository, integer IDs and SHAs only.
    if (!/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/(?:pulls\/[1-9][0-9]*(?:\/reviews\?per_page=100&page=[1-9][0-9]*)?|commits\/[a-f0-9]{40}\/(?:check-runs\?filter=latest&per_page=100&page=[1-9][0-9]*|statuses\?per_page=100&page=[1-9][0-9]*))$/.test(path)) throw failure();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await this.#fetch(`${API}${path}`, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (!response.ok || response.redirected || (response.url && response.url !== `${API}${path}`)) throw failure();
      const size = response.headers.get('content-length');
      if (size && (!/^\d+$/.test(size) || Number(size) > this.#maxBody)) throw failure();
      if (!response.body) throw failure();
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > this.#maxBody) throw failure();
        chunks.push(Buffer.from(chunk));
      }
      const link = response.headers.get('link');
      let next = null;
      if (link) {
        for (const part of link.split(',')) {
          const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
          if (!match) throw failure();
          const url = new URL(match[1]);
          if (url.origin !== API || url.username || url.password || url.hash ||
              url.pathname !== new URL(`${API}${path}`).pathname) throw failure();
          if (match[2] === 'next') next = url.href;
        }
      }
      return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), next };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async #pages(path, token, field) {
    const result = [];
    const ids = new Set();
    let expectedTotal;
    for (let page = 1; page <= this.#maxPages; page++) {
      const { data, next } = await this.#get(`${path}&page=${page}`, token);
      const items = field ? data?.[field] : data;
      if (!Array.isArray(items) || items.length > PAGE_SIZE) throw failure();
      if (field) {
        if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
            (expectedTotal !== undefined && expectedTotal !== data.total_count)) throw failure();
        expectedTotal = data.total_count;
      }
      for (const item of items) {
        if (!positive(item?.id) || ids.has(item.id)) throw failure();
        ids.add(item.id);
        result.push(item);
      }
      if (next && next !== `${API}${path}&page=${page + 1}`) throw failure();
      if (items.length < PAGE_SIZE && !next) {
        if (field && result.length !== expectedTotal) throw failure();
        return result;
      }
      if (field && result.length > expectedTotal) throw failure();
    }
    // Full final pages and any truncated response are never treated as complete.
    throw failure();
  }

  async readPullRequest(input) {
    try {
      const bound = target(input);
      const token = await this.#credential(bound);
      const prefix = `/repos/${bound.repository}`;
      const pullPath = `${prefix}/pulls/${bound.pullRequest}`;
      const { data: pull } = await this.#get(pullPath, token);
      validatePull(pull, bound);
      if (pull.state === 'open' && pull.draft) return null;
      if (pull.state === 'closed') return { pull, reviews: [], checks: [], statuses: [] };
      const commitPath = `${prefix}/commits/${pull.head.sha}`;
      const [reviews, checks, statuses] = await Promise.all([
        this.#pages(`${pullPath}/reviews?per_page=100`, token),
        this.#pages(`${commitPath}/check-runs?filter=latest&per_page=100`, token, 'check_runs'),
        this.#pages(`${commitPath}/statuses?per_page=100`, token),
      ]);
      const { data: latest } = await this.#get(pullPath, token);
      validatePull(latest, bound);
      if (latest.head.sha !== pull.head.sha || latest.state !== pull.state || latest.draft !== pull.draft) return null;
      return { pull, reviews, checks, statuses };
    } catch { throw failure(); }
  }
}

function validatePull(pull, bound) {
  if (pull?.number !== bound.pullRequest || pull?.base?.repo?.full_name?.toLowerCase() !== bound.repository ||
      !sha(pull?.head?.sha) || !['open', 'closed'].includes(pull.state) || typeof pull.merged !== 'boolean' || typeof pull.draft !== 'boolean' ||
      (pull.merged && pull.state !== 'closed')) throw failure();
}

function normalizedEvidence(reviews, checks) {
  const review = reviews.filter((item) => item?.user?.id === GREPTILE_BOT && item.user.type === 'Bot' &&
    ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(item.state) && item.submitted_at && sha(item.commit_id))
    .sort((a, b) => a.id - b.id)[0];
  if (review) return [{ kind: 'review', id: review.id, commit: review.commit_id, state: review.state, actorId: GREPTILE_BOT }];
  const check = checks.filter((item) => item?.app?.id === GREPTILE_APP && item.status === 'completed' &&
    ['success', 'failure'].includes(item.conclusion) && item.completed_at && sha(item.head_sha)).sort((a, b) => a.id - b.id)[0];
  return check ? [{ kind: 'check', id: check.id, commit: check.head_sha, state: check.conclusion, appId: GREPTILE_APP }] : [];
}

function settledChecks(checks, statuses, head) {
  const normalized = [];
  let settled = true;
  for (const check of checks) {
    if (!positive(check?.id) || !positive(check?.app?.id) || check.head_sha !== head || typeof check.name !== 'string' ||
        check.name.length > 512 || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(check.status)) throw failure();
    if (check.status !== 'completed' || !['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(check.conclusion)) settled = false;
    normalized.push({ kind: 'check', id: check.id, appId: check.app.id, name: check.name, conclusion: check.conclusion });
  }
  const latest = new Map();
  for (const status of statuses) {
    if (!positive(status?.id) || typeof status.context !== 'string' || status.context.length > 512 ||
        !['pending', 'success', 'failure', 'error'].includes(status.state)) throw failure();
    if (!latest.has(status.context) || latest.get(status.context).id < status.id) latest.set(status.context, status);
  }
  for (const status of latest.values()) {
    if (status.state === 'pending') settled = false;
    normalized.push({ kind: 'status', id: status.id, name: status.context, conclusion: status.state });
  }
  normalized.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
  return { settled, results: settled ? normalized : [] };
}

/** Observe one explicitly tracked PR. This is an event hint, never a readiness claim. */
export async function observePullRequest(input, { client = new GitHubReadClient() } = {}) {
  try {
    const bound = target(input);
    const snapshot = await client.readPullRequest(bound);
    if (snapshot === null) return null;
    const { pull, reviews, checks, statuses } = snapshot;
    validatePull(pull, bound);
    if (pull.state === 'open' && pull.draft) return null;
    const base = { repository: bound.repository, pullRequest: bound.pullRequest, head: pull.head.sha, state: pull.state, merged: pull.merged };
    let reviewEvidence = [];
    let aggregate = { settled: false, results: [] };
    let reason = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : null;
    if (!reason) {
      aggregate = settledChecks(checks, statuses, base.head);
      reviewEvidence = normalizedEvidence(reviews, checks);
      // The host's durable flag permits repair-head events, but is never emitted
      // as trusted review evidence or used to assert readiness.
      if (!reviewEvidence.length && !bound.reviewRecorded) return null;
      reason = aggregate.settled ? 'checks-settled' : reviewEvidence.length ? 'review-completed' : 'head-observed';
    }
    const event = { ...base, reason, reviewEvidence, checksSettled: aggregate.settled, checks: aggregate.results };
    return { ...event, actionKey: createHash('sha256').update(JSON.stringify(event)).digest('hex') };
  } catch { throw failure(); }
}
