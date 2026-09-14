import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { GitHubReadClient, observePullRequest } from '../src/github-events.mjs';

const head = 'a'.repeat(40);
const older = 'b'.repeat(40);
const input = { repository: 'Owner/Repo', pullRequest: 12, repoPath: resolve('.') };
const pull = () => ({ number: 12, base: { repo: { full_name: 'Owner/Repo' } }, head: { sha: head }, state: 'open', merged: false, draft: false });
const review = (extra = {}) => ({ id: 3, user: { id: 165735046, type: 'Bot' }, state: 'COMMENTED', submitted_at: '2026-01-01', commit_id: head, ...extra });
const check = (extra = {}) => ({ id: 4, app: { id: 1 }, name: 'test', head_sha: head, status: 'completed', conclusion: 'success', completed_at: '2026-01-01', ...extra });
const response = (data, headers) => new Response(JSON.stringify(data), { status: 200, headers });

function fixture({ pr = pull(), reviews = [], checks = [], statuses = [], git, fetch, ...options } = {}) {
  const calls = [];
  const gitCalls = [];
  const token = 'test-secret-never-log';
  const client = new GitHubReadClient({ ...options,
    runGit: async (args, opts) => {
      gitCalls.push({ args, opts });
      if (git) return git(args, opts);
      return args[0] === 'remote' ? 'https://github.com/Owner/Repo.git\n' : `protocol=https\nhost=github.com\nusername=owner\npassword=${token}\n`;
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (fetch) return fetch(url, opts);
      if (url.includes('/reviews?')) return response(reviews);
      if (url.includes('/check-runs?')) return response({ total_count: checks.length, check_runs: checks });
      if (url.includes('/statuses?')) return response(statuses);
      return response(pr);
    },
  });
  return { client, calls, gitCalls, token, observe: () => observePullRequest(input, { client }) };
}

test('pending initial review produces no event; uses bounded GET and existing credentials only', async () => {
  const f = fixture({ checks: [check({ status: 'in_progress', conclusion: null })] });
  assert.equal(await f.observe(), null);
  assert.equal(f.gitCalls.length, 2);
  assert.deepEqual(f.gitCalls[0].args, ['remote', 'get-url', 'origin']);
  assert.deepEqual(f.gitCalls[1].args, ['credential', 'fill']);
  assert.equal(f.gitCalls[1].opts.input, 'protocol=https\nhost=github.com\n\n');
  assert.equal(f.gitCalls[1].opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(f.gitCalls[1].opts.env.GCM_INTERACTIVE, 'Never');
  assert.equal(f.gitCalls[1].opts.windowsHide, true);
  assert.ok(f.gitCalls[1].opts.timeout <= 30_000);
  for (const { url, opts } of f.calls) {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(opts.method, 'GET');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, `Bearer ${f.token}`);
    assert.ok(opts.signal instanceof AbortSignal);
  }
  assert.equal(inspect(f.client).includes(f.token), false);
  assert.equal(JSON.stringify(f.client).includes(f.token), false);
});

test('rejects invalid input before Git or credential access', async () => {
  for (const change of [{ repository: '../repo' }, { repository: 'owner/..' }, { repository: 'owner/repo?x=1' },
    { repository: 'owner/repo\npassword=x' }, { pullRequest: '12' }, { pullRequest: 0 }, { pullRequest: 1.5 },
    { repoPath: 'relative' }, { reviewRecorded: 'true' }]) {
    const f = fixture();
    await assert.rejects(observePullRequest({ ...input, ...change }, { client: f.client }), /GitHub observation failed/);
    assert.equal(f.gitCalls.length, 0);
  }
});

test('rejects foreign and credential-bearing origins before credential acquisition', async () => {
  for (const origin of ['https://evil.test/owner/repo.git', 'https://github.com/other/repo.git',
    'https://secret@github.com/owner/repo.git', 'https://github.com.evil.test/owner/repo.git',
    'https://github.com/owner/repo.git?x=1', 'https://github.com:444/owner/repo.git']) {
    const f = fixture({ git: async () => origin });
    await assert.rejects(f.observe(), /GitHub observation failed/);
    assert.equal(f.gitCalls.length, 1);
    assert.equal(f.calls.length, 0);
  }
});

test('accepts matching SSH origin while retrieving the existing HTTPS GitHub credential', async () => {
  const f = fixture({ git: async (args) => args[0] === 'remote' ? 'git@github.com:OWNER/Repo.git' : 'protocol=https\nhost=github.com\npassword=secret\n' });
  assert.equal(await f.observe(), null);
  assert.equal(f.gitCalls[1].opts.input, 'protocol=https\nhost=github.com\n\n');
});

test('Git child environment strips bridge/provider secrets and inherited Git overrides', async (t) => {
  const keys = ['ENIGMA_SLACK_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'NODE_OPTIONS'];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]));
  keys.forEach((key) => { process.env[key] = 'test-unrelated-secret'; });
  const f = fixture();
  await f.observe();
  for (const { opts } of f.gitCalls) {
    for (const key of keys) assert.equal(opts.env[key], undefined);
    assert.equal(Object.values(opts.env).includes('test-unrelated-secret'), false);
  }
});

test('ignores open drafts and rejects missing draft metadata', async () => {
  const pr = { ...pull(), draft: true };
  const f = fixture({ pr, reviews: [review()] });
  assert.equal(await f.observe(), null);
  assert.equal(f.calls.length, 1);
  delete pr.draft;
  await assert.rejects(f.observe(), /GitHub observation failed/);
});

test('sanitizes credential, subprocess, transport, parse and HTTP failures without causes', async () => {
  const secret = 'private-secret-auth-value';
  const variants = [
    { git: async () => { throw Object.assign(new Error(secret), { stdout: secret, stderr: secret }); } },
    { git: async (args) => args[0] === 'remote' ? 'https://github.com/owner/repo' : `protocol=https\nhost=evil.test\npassword=${secret}\n` },
    { fetch: async () => { throw new Error(secret); } },
    { fetch: async () => new Response(secret, { status: 403 }) },
    { fetch: async () => new Response(secret, { status: 200 }) },
    { fetch: async () => new Response(secret, { status: 302, headers: { location: 'https://evil.test' } }) },
  ];
  for (const opts of variants) {
    await assert.rejects(fixture(opts).observe(), (error) => {
      assert.equal(inspect(error).includes(secret), false);
      assert.equal(error.cause, undefined);
      return /GitHub observation failed/.test(error.message);
    });
  }
});

test('refuses redirected and foreign response origins even if transport returns OK', async () => {
  for (const change of [{ redirected: true }, { url: 'https://evil.test/repos/owner/repo/pulls/12' }]) {
    const f = fixture({ fetch: async () => {
      const result = response(pull());
      for (const [key, value] of Object.entries(change)) Object.defineProperty(result, key, { value });
      return result;
    } });
    await assert.rejects(f.observe(), /GitHub observation failed/);
    assert.equal(f.calls.length, 1);
  }
});

test('bounds advertised and streamed response bodies', async () => {
  for (const headers of [{ 'content-length': '9999999' }, {}]) {
    const f = fixture({ maxBodyBytes: 64, fetch: async () => response({ value: 'x'.repeat(100) }, headers) });
    await assert.rejects(f.observe(), /GitHub observation failed/);
  }
});

test('aborts stalled network requests on timeout', async () => {
  const f = fixture({ timeoutMs: 10, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('sensitive network error')), { once: true });
  }) });
  await assert.rejects(f.observe(), /GitHub observation failed/);
});

test('trusted first review wakes once while pending updates keep the same fingerprint', async () => {
  const checks = [check({ status: 'queued', conclusion: null })];
  const reviews = [review({ body: 'untrusted raw text' }), review({ id: 50, commit_id: older })];
  const f = fixture({ reviews, checks });
  const first = await f.observe();
  assert.equal(first.reason, 'review-completed');
  assert.equal(first.checksSettled, false);
  assert.equal(first.repository, 'owner/repo');
  assert.equal(first.reviewEvidence[0].id, 3);
  assert.deepEqual(first.checks, []);
  checks[0].status = 'in_progress';
  checks[0].id = 100;
  reviews[0].submitted_at = 'later';
  reviews[0].body = 'different raw text';
  assert.equal((await f.observe()).actionKey, first.actionKey);
  assert.equal(JSON.stringify(first).includes('raw text'), false);
  checks[0].status = 'completed';
  checks[0].conclusion = 'failure';
  const settled = await f.observe();
  assert.equal(settled.reason, 'checks-settled');
  assert.equal(settled.checksSettled, true);
  assert.notEqual(settled.actionKey, first.actionKey);
  assert.equal(settled.checks[0].conclusion, 'failure');
});

test('matching display names and pending reviews are not trusted evidence', async () => {
  for (const r of [review({ user: { id: 9, type: 'Bot', login: 'greptile' } }),
    review({ state: 'PENDING' }), review({ submitted_at: null }), review({ user: { id: 165735046, type: 'User' } })]) {
    assert.equal(await fixture({ reviews: [r] }).observe(), null);
  }
});

test('trusted completed app check supplies evidence; pending app check does not', async () => {
  const checks = [check({ app: { id: 867647 } })];
  const f = fixture({ checks });
  assert.deepEqual((await f.observe()).reviewEvidence, [{ kind: 'check', id: 4, commit: head, state: 'success', appId: 867647 }]);
  checks[0].status = 'in_progress';
  checks[0].conclusion = null;
  assert.equal(await f.observe(), null);
});

test('all latest status contexts must settle, and obsolete pending statuses do not block', async () => {
  const statuses = [{ id: 10, context: 'build', state: 'pending' }, { id: 11, context: 'build', state: 'success' },
    { id: 12, context: 'deploy', state: 'pending' }];
  const f = fixture({ reviews: [review()], statuses });
  assert.equal((await f.observe()).checksSettled, false);
  statuses.push({ id: 13, context: 'deploy', state: 'error' });
  const event = await f.observe();
  assert.equal(event.checksSettled, true);
  assert.deepEqual(event.checks.map((item) => item.id), [11, 13]);
});

test('settled repair checks can wake without a new Greptile review', async () => {
  const { client } = fixture({ checks: [check()] });
  assert.equal(await observePullRequest(input, { client }), null);
  const event = await observePullRequest({ ...input, reviewRecorded: true }, { client });
  assert.equal(event.reason, 'checks-settled');
  assert.equal(event.checksSettled, true);
  assert.deepEqual(event.reviewEvidence, []);
});

test('recorded initial review permits one stable pending repair-head observation without fabricating evidence', async () => {
  const pr = pull();
  const checks = [check({ status: 'queued', conclusion: null })];
  const { client } = fixture({ pr, checks });
  const observe = () => observePullRequest({ ...input, reviewRecorded: true }, { client });
  const first = await observe();
  assert.equal(first.reason, 'head-observed');
  assert.deepEqual(first.reviewEvidence, []);
  assert.equal(first.checksSettled, false);
  checks[0].status = 'in_progress';
  checks[0].id++;
  assert.equal((await observe()).actionKey, first.actionKey);
  pr.head.sha = older;
  checks[0].head_sha = older;
  const repair = await observe();
  assert.notEqual(repair.actionKey, first.actionKey);
  assert.equal((await observe()).actionKey, repair.actionKey);
  checks[0].status = 'completed';
  checks[0].conclusion = 'success';
  const settled = await observe();
  assert.equal(settled.reason, 'checks-settled');
  assert.notEqual(settled.actionKey, repair.actionKey);
});

test('cancelled Greptile checks are not review evidence while another check is pending', async () => {
  const event = await fixture({ checks: [check({ app: { id: 867647 }, conclusion: 'cancelled' }),
    check({ id: 5, status: 'in_progress', conclusion: null })] }).observe();
  assert.equal(event, null);
});

test('closed and merged PRs emit distinct stable events without review reads', async () => {
  const pr = pull();
  pr.state = 'closed';
  const f = fixture({ pr });
  const closed = await f.observe();
  assert.equal(closed.reason, 'closed');
  assert.equal(f.calls.length, 1);
  pr.merged = true;
  const merged = await f.observe();
  assert.equal(merged.reason, 'merged');
  assert.notEqual(merged.actionKey, closed.actionKey);
  assert.equal((await f.observe()).actionKey, merged.actionKey);
});

test('fails closed on PR identity mismatch or head moving during observation', async () => {
  const wrong = pull();
  wrong.base.repo.full_name = 'other/repo';
  await assert.rejects(fixture({ pr: wrong }).observe(), /GitHub observation failed/);
  let reads = 0;
  const f = fixture({ fetch: async (url) => {
    if (url.includes('/check-runs?')) return response({ total_count: 0, check_runs: [] });
    if (url.includes('?')) return response([]);
    const pr = pull();
    if (++reads > 1) pr.head.sha = older;
    return response(pr);
  } });
  assert.equal(await f.observe(), null);
});

test('paginates full pages with constructed same-origin URLs and includes later evidence', async () => {
  const f = fixture({ fetch: async (url) => {
    if (url.includes('/reviews?')) {
      if (url.endsWith('page=1')) return response(Array.from({ length: 100 }, (_, i) => review({ id: i + 1, user: { id: 9 } })),
        { link: '<https://api.github.com/repos/owner/repo/pulls/12/reviews?per_page=100&page=2>; rel="next"' });
      return response([review({ id: 101 })]);
    }
    if (url.includes('/check-runs?')) return response({ total_count: 0, check_runs: [] });
    if (url.includes('/statuses?')) return response([]);
    return response(pull());
  } });
  assert.equal((await f.observe()).reviewEvidence[0].id, 101);
  assert.ok(f.calls.some(({ url }) => url.endsWith('reviews?per_page=100&page=2')));
});

test('fails closed on pagination limits, foreign links, duplicates and inconsistent totals', async () => {
  for (const variant of ['limit', 'foreign', 'duplicate', 'total', 'short-next']) {
    const f = fixture({ maxPages: 1, fetch: async (url) => {
      if (url.includes('/reviews?')) {
        if (variant === 'limit') return response(Array.from({ length: 100 }, (_, i) => review({ id: i + 1 })));
        if (variant === 'foreign') return response([], { link: '<https://evil.test/repos/owner/repo/pulls/12/reviews?page=2>; rel="next"' });
        if (variant === 'short-next') return response([], { link: '<https://api.github.com/repos/owner/repo/pulls/12/reviews?per_page=100&page=2>; rel="next"' });
        if (variant === 'duplicate') return response([review(), review()]);
        return response([review()]);
      }
      if (url.includes('/check-runs?')) return response({ total_count: variant === 'total' ? 100 : 0, check_runs: [] });
      if (url.includes('/statuses?')) return response([]);
      return response(pull());
    } });
    await assert.rejects(f.observe(), /GitHub observation failed/);
    assert.ok(f.calls.every(({ url }) => new URL(url).origin === 'https://api.github.com'));
  }
});
