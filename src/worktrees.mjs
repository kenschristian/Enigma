import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, join, normalize } from 'node:path';

const runFile = promisify(execFile);
const canonical = (path) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);

export class WorktreeManager {
  constructor({ repoPath, worktreesRoot, gitCommand = 'git' }) {
    this.repoPath = resolve(repoPath);
    this.worktreesRoot = resolve(worktreesRoot);
    this.gitCommand = gitCommand;
    this.pending = new Map();
  }

  async git(args, cwd = this.repoPath) {
    try {
      const { stdout } = await runFile(this.gitCommand, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      // Git output can contain credential-bearing remotes and user-controlled data.
      throw new Error('Git operation failed; inspect the repository locally');
    }
  }

  async inspect() {
    try {
      await this.git(['rev-parse', '--verify', 'HEAD^{commit}']);
    } catch {
      throw new Error('Repository HEAD must resolve to a commit; verify Git access and create an initial commit if needed');
    }
    const [branch, status, remotes] = await Promise.all([
      this.git(['branch', '--show-current']),
      this.git(['status', '--porcelain']),
      this.git(['remote']),
    ]);
    const names = remotes ? remotes.split(/\r?\n/) : [];
    // Report names only; remote URLs may embed credentials.
    return { branch: branch || null, clean: status === '', remotes: names };
  }

  ensure(conversationKey) {
    if (typeof conversationKey !== 'string' || !conversationKey) return Promise.reject(new Error('Conversation key is required'));
    if (this.pending.has(conversationKey)) return this.pending.get(conversationKey);
    const pending = this.ensureOnce(conversationKey).finally(() => this.pending.delete(conversationKey));
    this.pending.set(conversationKey, pending);
    return pending;
  }

  async ensureOnce(conversationKey) {
    await this.git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const hash = createHash('sha256').update(conversationKey).digest('hex');
    const path = join(this.worktreesRoot, hash);
    const branch = `codex/conversation-${hash}`;
    await mkdir(this.worktreesRoot, { recursive: true });
    const listing = await this.git(['worktree', 'list', '--porcelain', '-z']);
    const records = listing.split('\0\0').filter(Boolean).map((record) => Object.fromEntries(
      record.split('\0').filter(Boolean).map((line) => {
        const index = line.indexOf(' ');
        return index === -1 ? [line, true] : [line.slice(0, index), line.slice(index + 1)];
      })
    ));
    const entry = records.find((record) => canonical(resolve(record.worktree)) === canonical(path));
    if (entry) {
      if (entry.branch !== `refs/heads/${branch}` || entry.bare || entry.prunable) throw new Error('Worktree mapping does not match conversation');
      await this.validate(path, branch);
      return { path, branch };
    }
    try {
      await lstat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A pre-existing branch without the expected worktree is ambiguous: preserve it.
      const existingBranches = await this.git(['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
      if (existingBranches) throw new Error('Conversation branch exists without its expected worktree');
      await this.git(['worktree', 'add', '-b', branch, '--', path, 'HEAD']);
      await this.validate(path, branch);
      return { path, branch };
    }
    throw new Error('Conversation worktree path already exists without its expected mapping');
  }

  async validate(path, branch) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Worktree path is not a regular directory');
    const [actualPath, rootPath, common, expectedCommon, actualBranch] = await Promise.all([
      realpath(path),
      this.git(['rev-parse', '--show-toplevel'], path),
      this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path),
      this.git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(['symbolic-ref', '--quiet', 'HEAD'], path),
    ]);
    if (canonical(actualPath) !== canonical(await realpath(rootPath)) ||
        canonical(await realpath(common)) !== canonical(await realpath(expectedCommon)) ||
        actualBranch !== `refs/heads/${branch}`) throw new Error('Worktree repository or branch does not match conversation');
  }
}
