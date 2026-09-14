import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';

const MAX_FRAME = 8 * 1024 * 1024;
const safeError = (code, message) => Object.assign(new Error(message), { code });
const protocolError = () => safeError('CODEX_PROTOCOL', 'Codex returned an invalid protocol message.');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' || Number.isSafeInteger(value);
const safetyConfig = {
  forced_login_method: 'chatgpt', model_provider: 'openai',
  sandbox_mode: 'workspace-write', approval_policy: 'on-request', approvals_reviewer: 'user',
  'sandbox_workspace_write.network_access': false,
};
const PROFILE_ID = 'enigma_workspace';
const profileError = () => safeError('CODEX_PROFILE', 'Codex did not confirm the required workspace permission profile. No work was started.');
const pathIdentity = value => typeof value === 'string' ? normalize(value).replace(/[\\/]+$/, '').toLowerCase() : null;
const reservedConfig = /^(permissions|default_permissions|sandbox_mode|sandbox_workspace_write|approval_policy|approvals_reviewer|forced_login_method|model_provider|windows)(\.|$)/;
// JSON strings use the same escapes as TOML basic strings for these validated paths.
const toml = value => typeof value === 'string' ? JSON.stringify(value) : typeof value === 'boolean' ? String(value)
  : `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
const withoutNullDefaults = value => object(value) ? Object.fromEntries(Object.entries(value)
  .filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNullDefaults(item)])) : value;

function trustedNodeExecutable() {
  try {
    // This is the running bridge's executable, never a task/config-supplied path.
    const executable = realpathSync.native(process.execPath);
    if (!isAbsolute(executable) || /[\x00-\x1f";%!]/.test(executable) || !statSync(executable).isFile()) throw new Error();
    return executable;
  } catch {
    throw safeError('CODEX_NODE_RUNTIME', 'The trusted Node executable could not be validated. No runtime access was added.');
  }
}

function workspaceProfile(workspace) {
  if (!object(workspace) || ![workspace.path, workspace.gitCommonDir].every(value =>
    typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value) && normalize(value) !== parse(value).root)) {
    throw new TypeError('Invalid validated Codex workspace.');
  }
  const path = normalize(workspace.path);
  const gitCommonDir = normalize(workspace.gitCommonDir);
  const nodeExecutable = trustedNodeExecutable();
  const profile = { filesystem: { ':minimal': 'read', [path]: 'write', [gitCommonDir]: 'read',
    [join(path, '.git')]: 'read', [join(path, '.codex')]: 'read', [join(path, '.agents')]: 'read', [nodeExecutable]: 'read' },
    network: { enabled: false } };
  return { path, profile, nodeExecutable };
}

export function codexEnvironment(source = process.env, platform = process.platform) {
  const entries = Object.entries(source).filter(([key]) =>
    !/^(OPENAI_API_KEY$|OPENAI_ADMIN_KEY$|CODEX_API_KEY$|ENIGMA_)/i.test(key));
  if (platform !== 'win32') return Object.fromEntries(entries);
  const normalized = new Map();
  // Windows keys are case-insensitive. Match Node's deterministic first-key
  // selection, then use PATH because the Codex sandbox adds that exact spelling.
  // Keeping inherited Path as well makes Windows PowerShell's Env provider fail.
  for (const [key, value] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const identity = key.toUpperCase();
    if (!normalized.has(identity)) normalized.set(identity, [identity === 'PATH' ? 'PATH' : key, value]);
  }
  const environment = Object.fromEntries(normalized.values());
  const runtimeDirectory = dirname(trustedNodeExecutable());
  if (environment.PATH !== undefined && (typeof environment.PATH !== 'string' || /[\x00\r\n]/.test(environment.PATH))) {
    throw new TypeError('Invalid Windows child PATH.');
  }
  const searchPath = environment.PATH ?? '';
  if (!searchPath.split(';').some(entry => pathIdentity(entry.replace(/^"|"$/g, '')) === pathIdentity(runtimeDirectory))) {
    environment.PATH = searchPath ? `${searchPath};${runtimeDirectory}` : runtimeDirectory;
  }
  return environment;
}

/** One stdio app-server connection, with at most one active run. Never logs RPC data. */
export class CodexClient {
  constructor({ command = 'codex', args = [], cwd, workspace, requestTimeoutMs = 30000, spawnFn = spawn } = {}) {
    if (typeof command !== 'string' || !Array.isArray(args) || !args.every(x => typeof x === 'string') ||
        !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('Invalid Codex client options.');
    Object.assign(this, { command, args, cwd, requestTimeoutMs, spawnFn });
    if (process.platform === 'win32' && workspace !== undefined) {
      this.workspace = workspaceProfile(workspace);
      if ((cwd !== undefined && pathIdentity(cwd) !== pathIdentity(this.workspace.path)) || args.length) {
        throw new TypeError('Workspace clients require a matching cwd and no additional CLI arguments.');
      }
      this.cwd = this.workspace.path;
    }
    this.policyConfig = this.workspace ? {
      forced_login_method: 'chatgpt', model_provider: 'openai', approval_policy: 'on-request', approvals_reviewer: 'user',
      [`permissions.${PROFILE_ID}`]: this.workspace.profile, default_permissions: PROFILE_ID, 'windows.sandbox': 'elevated',
    } : safetyConfig;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  start() {
    if (this.closed) return Promise.reject(safeError('CODEX_CLOSED', 'Codex connection is closed.'));
    return this.starting ??= this.initialize();
  }

  async initialize() {
    try {
      if (this.workspace && trustedNodeExecutable() !== this.workspace.nodeExecutable) {
        throw safeError('CODEX_NODE_RUNTIME', 'The trusted Node executable changed before startup. No work was started.');
      }
      const overrides = Object.entries(this.policyConfig).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
      this.child = this.spawnFn(this.command, [...this.args, 'app-server', '--listen', 'stdio://', ...overrides], {
        cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
        // Auth comes only from the existing Codex ChatGPT login. Do not inherit API credentials.
        env: codexEnvironment(),
      });
      this.childExit = new Promise(resolve => {
        this.child.once('exit', () => { resolve(); this.fail(safeError('CODEX_EXIT', 'Codex app-server exited before the operation finished.')); });
        this.child.on('error', () => {
          // A failed spawn has no process to wait for. Other errors still require exit confirmation.
          if (this.child.pid === undefined) resolve();
          this.fail(safeError('CODEX_START', 'Could not start the installed Codex app-server.'));
        });
      });
      this.child.stdout.on('data', chunk => this.receive(chunk));
      this.child.stdout.on('error', () => this.fail(safeError('CODEX_IO', 'Codex output stream failed.')));
      this.child.stdout.on('end', () => this.fail(safeError('CODEX_EXIT', 'Codex app-server output closed.')));
      this.child.stdin.on('error', () => this.fail(safeError('CODEX_IO', 'Codex input stream failed.')));
      this.child.stderr.on('error', () => {});
      this.child.stderr.resume();
      await this.request('initialize', {
        clientInfo: { name: 'enigma_slack_bridge', title: 'Enigma', version: '1.0.0' },
        capabilities: { experimentalApi: Boolean(this.workspace), requestAttestation: false },
      });
      this.write({ method: 'initialized', params: {} });
      return this;
    } catch (error) {
      const safe = error?.code?.startsWith('CODEX_') ? error : safeError('CODEX_START', 'Could not initialize Codex app-server.');
      this.fail(safe);
      throw safe;
    }
  }

  write(message) {
    if (this.closed) throw safeError('CODEX_CLOSED', 'Codex connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeout = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(safeError('CODEX_CLOSED', 'Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(safeError('CODEX_RPC_TIMEOUT', 'Codex request timed out.')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { this.fail(safeError('CODEX_IO', 'Could not write to Codex app-server.')); }
    });
  }

  receive(chunk) {
    if (this.closed) return;
    try {
      this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        if (newline > MAX_FRAME) throw protocolError();
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.dispatch(JSON.parse(line));
      }
      if (this.buffer.length > MAX_FRAME) throw protocolError();
    } catch { this.fail(protocolError()); }
  }

  dispatch(message) {
    if (!object(message)) throw protocolError();
    if ('method' in message) {
      if (typeof message.method !== 'string' || !object(message.params ?? {})) throw protocolError();
      if ('id' in message) {
        if (!validId(message.id)) throw protocolError();
        this.deny(message);
      } else this.notification(message.method, message.params ?? {});
      return;
    }
    if (!validId(message.id) || (('result' in message) === ('error' in message))) throw protocolError();
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if ('error' in message) pending.reject(safeError('CODEX_RPC', 'Codex rejected the request. Check local Codex setup and account access.'));
    else pending.resolve(message.result);
  }

  deny({ id, method }) {
    const denials = {
      'item/commandExecution/requestApproval': { decision: 'decline' },
      'item/fileChange/requestApproval': { decision: 'decline' },
      'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
      'item/tool/requestUserInput': { answers: {} },
      'item/tool/call': { contentItems: [], success: false },
      'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
      execCommandApproval: { decision: 'abort' },
      applyPatchApproval: { decision: 'abort' },
    };
    const known = Object.hasOwn(denials, method);
    this.write(known ? { id, result: denials[method] } : {
      id, error: { code: -32601, message: 'Client does not support this server request.' },
    });
    this.callback('onApproval', {
      method: known ? method : 'unsupported/serverRequest',
      reason: 'Request denied. Continue in the local Codex app if user input or approval is needed.',
    });
  }

  callback(name, value) {
    try {
      Promise.resolve(this.active?.[name]?.(value)).catch(() => this.fail(safeError('CODEX_CALLBACK', 'Codex progress callback failed.')));
    } catch { this.fail(safeError('CODEX_CALLBACK', 'Codex progress callback failed.')); }
  }

  async account() {
    await this.start();
    const result = await this.request('account/read', { refreshToken: false });
    if (!object(result) || (result.account !== null && !object(result.account))) throw protocolError();
    const account = result.account;
    return {
      account: account ? { type: account.type, ...(account.type === 'chatgpt' ? { planType: account.planType } : {}) } : null,
      requiresOpenaiAuth: result.requiresOpenaiAuth === true,
    };
  }

  async models() {
    await this.start();
    const models = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await this.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      if (!object(page) || !Array.isArray(page.data)) throw protocolError();
      models.push(...page.data);
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || seen.has(cursor))) throw protocolError();
      seen.add(cursor);
      if (seen.size > 100) throw protocolError();
    } while (cursor);
    return models;
  }

  async run({ threadId, cwd, model, effort, instructions = '', prompt, config = {},
    timeoutMs = 45 * 60 * 1000, signal, onThread, onProgress, onApproval } = {}) {
    if (this.active) throw safeError('CODEX_BUSY', 'This Codex connection already has an active run.');
    if (!isAbsolute(cwd ?? '') || typeof model !== 'string' || !model || typeof effort !== 'string' || !effort ||
        typeof prompt !== 'string' || !prompt.trim() || typeof instructions !== 'string' || !object(config) ||
        (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid Codex run options.');
    if (signal?.aborted) throw safeError('CODEX_CANCELLED', 'Codex task was cancelled.');
    if (this.workspace && (pathIdentity(cwd) !== pathIdentity(this.workspace.path) || Object.keys(config).some(key => reservedConfig.test(key)))) {
      throw safeError('CODEX_PROFILE', 'The run workspace or configuration conflicts with the required permission profile.');
    }
    let resolve, reject;
    const completion = new Promise((res, rej) => { resolve = res; reject = rej; });
    // Install a handler before setup: exit/abort can happen before the turn is started.
    completion.catch(() => {});
    const run = { threadId: null, turnId: null, messages: new Map(), early: [], resolve, reject, onProgress, onApproval };
    this.active = run;
    const abort = () => this.interrupt(safeError('CODEX_CANCELLED', 'Codex task was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.interrupt(safeError('CODEX_TIMEOUT', 'Codex task reached its time limit.')), timeoutMs);
    const check = () => { if (run.stopped || this.closed) throw run.stopped ?? safeError('CODEX_CLOSED', 'Codex connection is closed.'); };
    try {
      // Race setup against cancellation so a stalled persistence callback cannot block shutdown.
      const setup = async () => {
        const account = await this.account();
        check();
        if (account.account?.type !== 'chatgpt') throw safeError('CODEX_AUTH', 'Sign in to the installed Codex CLI with the existing ChatGPT account. API billing is not allowed.');
        const available = (await this.models()).find(entry => entry.model === model);
        check();
        if (!available || !available.supportedReasoningEfforts?.some(option => option.reasoningEffort === effort)) {
          throw safeError('CODEX_MODEL', 'The requested Codex model and reasoning effort are unavailable. No substitute was selected.');
        }
        if (this.workspace) {
          // Config layers can merge tables. Check the effective profile, not just its name,
          // so a same-name user/project profile cannot add inherited access silently.
          let effective;
          try { effective = await this.request('config/read', { cwd: this.workspace.path, includeLayers: false }); }
          catch { const error = profileError(); this.fail(error); throw error; }
          check();
          if (!isDeepStrictEqual(withoutNullDefaults(effective?.config?.permissions?.[PROFILE_ID]), this.workspace.profile)) {
            const error = profileError(); this.fail(error); throw error;
          }
        }
        const params = {
          ...(threadId ? { threadId, excludeTurns: true } : {}), cwd, model, modelProvider: 'openai',
          approvalPolicy: 'on-request', approvalsReviewer: 'user',
          ...(this.workspace ? { permissions: PROFILE_ID, runtimeWorkspaceRoots: [this.workspace.path] } : { sandbox: 'workspace-write' }),
          developerInstructions: this.workspace ? `${instructions}\n\nFor Node checks use the trusted executable with shell C:\\Windows\\System32\\cmd.exe, login:false and the supplied absolute workdir. Preserve loader symlinks to avoid Node realpath traversal through private package ancestors. Copy this cmd command literally; do not add quotes or backslash escapes:\n\`\`\`cmd\ncall ${/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(this.workspace.nodeExecutable) ? this.workspace.nodeExecutable : `"${this.workspace.nodeExecutable}"`} --preserve-symlinks --preserve-symlinks-main --test\n\`\`\`\nAn explicit test-file path may follow --test. Keep normal test-process isolation. Only the executable file has extra read access. If any test or quoted-path invocation remains blocked, do not request approval or escalation, retry outside the sandbox, or read private parent folders. Report the command and failure to Atlas for host validation, preserve all work, and leave the task recoverable.` : instructions,
          config: { ...config, ...this.policyConfig, model, model_reasoning_effort: effort },
        };
        const result = await this.request(threadId ? 'thread/resume' : 'thread/start', params);
        check();
        if (typeof result?.thread?.id !== 'string' || result.model !== model || result.modelProvider !== 'openai') throw protocolError();
        if (this.workspace && (result.activePermissionProfile?.id !== PROFILE_ID || result.activePermissionProfile.extends !== null ||
            !Array.isArray(result.runtimeWorkspaceRoots) || result.runtimeWorkspaceRoots.length !== 1 ||
            pathIdentity(result.runtimeWorkspaceRoots[0]) !== pathIdentity(this.workspace.path))) {
          const error = profileError(); this.fail(error); throw error;
        }
        run.threadId = result.thread.id;
        try { await onThread?.(run.threadId); }
        catch { throw safeError('CODEX_PERSIST', 'Could not save the Codex thread before starting work.'); }
        check();
        run.startingTurn = true;
        const started = await this.request('turn/start', {
          threadId: run.threadId, cwd, model, effort, approvalPolicy: 'on-request', approvalsReviewer: 'user',
          ...(this.workspace ? { permissions: PROFILE_ID, runtimeWorkspaceRoots: [this.workspace.path] } : {
            sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          }),
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        });
        check();
        if (typeof started?.turn?.id !== 'string') throw protocolError();
        run.turnId = started.turn.id;
        for (const [method, params] of run.early) this.notification(method, params);
        run.early = [];
        if (['completed', 'failed', 'interrupted'].includes(started.turn.status)) this.finish(started.turn);
      };
      await Promise.race([setup(), completion]);
      return await completion;
    } catch (error) {
      if (run.threadId && !run.finished && !run.stopped) this.interrupt(safeError('CODEX_STOPPED', 'Codex task stopped before completion.'));
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (this.active === run) this.active = null;
    }
  }

  notification(method, params) {
    const run = this.active;
    if (!run || run.stopped || params.threadId !== run.threadId) return;
    if (!run.turnId) {
      if (run.startingTurn) {
        if (run.early.length >= 10000) throw protocolError();
        run.early.push([method, params]);
      }
      return;
    }
    if ((params.turnId ?? params.turn?.id) !== run.turnId) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (typeof params.item.text !== 'string' || typeof params.item.id !== 'string') throw protocolError();
      run.messages.set(params.item.id, params.item);
    } else if (method === 'turn/completed') this.finish(params.turn);
    else if (method === 'item/agentMessage/delta') this.callback('onProgress', { type: 'working' });
  }

  finish(turn) {
    const run = this.active;
    if (!run || run.finished || run.stopped) return;
    if (!['completed', 'failed', 'interrupted'].includes(turn.status)) throw protocolError();
    for (const item of turn.items ?? []) {
      if (item.type === 'agentMessage' && typeof item.text === 'string') run.messages.set(item.id, item);
    }
    const messages = [...run.messages.values()];
    const final = messages.filter(item => item.phase === 'final_answer');
    run.finished = true;
    run.resolve({ threadId: run.threadId, turnId: run.turnId, status: turn.status,
      text: (final.length ? final : messages.filter(item => item.phase !== 'commentary')).map(item => item.text).join('\n\n') });
  }

  interrupt(error) {
    const run = this.active;
    if (!run || run.stopped || run.finished) return;
    run.stopped = error;
    if (run.threadId && run.turnId && !this.closed) {
      // Write the interrupt before terminating; never wait indefinitely for acknowledgement.
      try { this.write({ id: ++this.sequence, method: 'turn/interrupt', params: { threadId: run.threadId, turnId: run.turnId } }); } catch {}
    }
    this.fail(error);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.active && !this.active.finished) {
      this.active.stopped ??= error;
      this.active.reject(error);
    }
    if (this.child) {
      // EOF also lets the server release its own resources when OS termination is restricted.
      try { this.child.stdin.end(); } catch {}
      // Windows kill() alone leaves descendants alive. The fixed argv targets only our child tree.
      if (process.platform === 'win32' && this.spawnFn === spawn && Number.isInteger(this.child.pid)) {
        const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => { try { this.child.kill(); } catch {} });
        killer.on('exit', code => { if (code !== 0) { try { this.child.kill(); } catch {} } });
      } else { try { this.child.kill(); } catch {} }
    }
  }

  async close() {
    if (this.active && !this.active.finished) this.interrupt(safeError('CODEX_CLOSED', 'Codex connection was closed.'));
    else this.fail(safeError('CODEX_CLOSED', 'Codex connection was closed.'));
    if (!this.childExit) return;
    let timer;
    try {
      await Promise.race([
        this.childExit,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(safeError('CODEX_SHUTDOWN',
            'Could not confirm Codex app-server shutdown. Keep this worktree blocked until its process has stopped.')), 5000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
