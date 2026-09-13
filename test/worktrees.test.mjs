import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorktreeManager } from '../src/worktrees.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = (key) => createHash('sha256').update(key).digest('hex');

async function fixture(t, commit = true) {
  const root = await mkdtemp(join(tmpdir(), 'enigma-worktrees-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const repoPath = join(root, 'repo with spaces');
  const worktreesRoot = join(root, 'worktrees');
  await mkdir(repoPath);
  git(repoPath, ['init']);
  await writeFile(join(repoPath, 'tracked.txt'), 'original\n');
  if (commit) {
    git(repoPath, ['add', '.']);
    git(repoPath, ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost', 'commit', '-m', 'Initial']);
  }
  return { repoPath, worktreesRoot, manager: new WorktreeManager({ repoPath, worktreesRoot }) };
}

test('creates stable isolated worktrees and preserves dirty and untracked files on reuse', async (t) => {
  const { manager, repoPath, worktreesRoot } = await fixture(t);
  const key = 'T1:C1:123.456; $(ignored)';
  const [first, simultaneous] = await Promise.all([manager.ensure(key), manager.ensure(key)]);
  assert.deepEqual(first, simultaneous);
  await writeFile(join(first.path, 'tracked.txt'), 'unfinished work\n');
  await writeFile(join(first.path, 'untracked.txt'), 'keep me');
  const reopened = new WorktreeManager({ repoPath, worktreesRoot });
  assert.deepEqual(await reopened.ensure(key), first);
  assert.equal(await readFile(join(first.path, 'tracked.txt'), 'utf8'), 'unfinished work\n');
  assert.equal(await readFile(join(first.path, 'untracked.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(join(repoPath, 'tracked.txt'), 'utf8'), 'original\n');
  const other = await manager.ensure('another conversation');
  assert.notEqual(other.path, first.path);
  assert.equal((await manager.inspect()).clean, true);
});

test('rejects an unborn repository without creating a worktree', async (t) => {
  const { manager } = await fixture(t, false);
  await assert.rejects(manager.ensure('key'), /Git operation failed/);
});

test('inspect rejects an unborn repository with safe actionable guidance', async (t) => {
  const { manager, repoPath } = await fixture(t, false);
  await assert.rejects(manager.inspect(), /HEAD must resolve to a commit/);
  assert.equal(await readFile(join(repoPath, 'tracked.txt'), 'utf8'), 'original\n');
});

test('inspect accepts a detached committed HEAD', async (t) => {
  const { manager, repoPath } = await fixture(t);
  git(repoPath, ['checkout', '--detach']);
  const info = await manager.inspect();
  assert.equal(info.branch, null);
  assert.equal(info.clean, true);
});

test('rejects existing directory collision and leaves contents intact', async (t) => {
  const { manager, worktreesRoot } = await fixture(t);
  const path = join(worktreesRoot, hash('key'));
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'important.txt'), 'user data');
  await assert.rejects(manager.ensure('key'), /already exists/);
  assert.equal(await readFile(join(path, 'important.txt'), 'utf8'), 'user data');
});

test('rejects branch changes at a mapped path without resetting or deleting work', async (t) => {
  const { manager } = await fixture(t);
  const worktree = await manager.ensure('key');
  git(worktree.path, ['switch', '-c', 'user-branch']);
  await writeFile(join(worktree.path, 'tracked.txt'), 'preserved');
  await assert.rejects(manager.ensure('key'), /mapping does not match/);
  assert.equal(git(worktree.path, ['branch', '--show-current']), 'user-branch');
  assert.equal(await readFile(join(worktree.path, 'tracked.txt'), 'utf8'), 'preserved');
});

test('rejects existing conversation branch at a different path', async (t) => {
  const { manager, repoPath } = await fixture(t);
  git(repoPath, ['branch', `codex/conversation-${hash('key')}`]);
  await assert.rejects(manager.ensure('key'), /branch exists/);
});

test('inspect reports safe remote names and dirty state without changing repository', async (t) => {
  const { manager, repoPath } = await fixture(t);
  git(repoPath, ['remote', 'add', 'origin', 'https://secret@example.test/repo.git']);
  await writeFile(join(repoPath, 'tracked.txt'), 'dirty');
  const info = await manager.inspect();
  assert.equal(info.clean, false);
  assert.deepEqual(info.remotes, ['origin']);
  assert.equal(JSON.stringify(info).includes('secret'), false);
});

test('Windows short paths reuse Git canonical mappings and still reject changed branches', { skip: process.platform !== 'win32' }, async (t) => {
  const { repoPath, worktreesRoot } = await fixture(t);
  await mkdir(worktreesRoot);
  const shortRoot = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:ENIGMA_TEST_FOLDER).ShortPath'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ENIGMA_TEST_FOLDER: worktreesRoot },
  }).trim();
  if (shortRoot.toLowerCase() === worktreesRoot.toLowerCase()) {
    t.skip('8.3 short paths are disabled on this test volume');
    return;
  }
  assert.equal((await realpath(shortRoot)).toLowerCase(), (await realpath(worktreesRoot)).toLowerCase());
  const manager = new WorktreeManager({ repoPath, worktreesRoot: shortRoot });
  const first = await manager.ensure('short-path-conversation');
  await writeFile(join(first.path, 'tracked.txt'), 'unfinished through short path');
  assert.deepEqual(await manager.ensure('short-path-conversation'), first);
  assert.equal(await readFile(join(first.path, 'tracked.txt'), 'utf8'), 'unfinished through short path');
  git(first.path, ['switch', '-c', 'user-short-path-branch']);
  await assert.rejects(manager.ensure('short-path-conversation'), /mapping does not match/);
  assert.equal(await readFile(join(first.path, 'tracked.txt'), 'utf8'), 'unfinished through short path');
});

test('a conversation path cannot reuse another mapped worktree through a directory link', async (t) => {
  const { manager, worktreesRoot } = await fixture(t);
  const first = await manager.ensure('original');
  const original = await readFile(join(first.path, 'tracked.txt'), 'utf8');
  const linkedPath = join(worktreesRoot, hash('linked'));
  await symlink(first.path, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.ensure('linked'), /already exists|not a regular directory/);
  assert.equal(await readFile(join(first.path, 'tracked.txt'), 'utf8'), original);
});
