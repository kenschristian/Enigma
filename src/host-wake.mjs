import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { codexEnvironment } from './codex.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failed = () => new Error('Host wake could not be confirmed.');
const MAX_FRAME = 256 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Queue input for an existing desktop thread, without starting/resuming a model.
 * The caller MUST persist the first add attempt before calling this function.
 * After a crash or an uncertain result, use reconcileOnly: true: an absent queue
 * entry may already have been consumed, and must never cause a duplicate add.
 * Queued means persisted, not proof that the desktop has run the message.
 */
export async function enqueueHostWake({ command, threadId, eventId, message, reconcileOnly = false } = {},
  { spawnFn = spawn, requestTimeoutMs = 5000, timeoutMs = 30000 } = {}) {
  if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f]/.test(command) || !uuid(threadId) || !uuid(eventId) ||
      typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 16384 || /\x00/.test(message) ||
      typeof reconcileOnly !== 'boolean' || typeof spawnFn !== 'function' ||
      !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 30000 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new TypeError('Invalid host wake options.');
  }
  let child, deadline, dead = false, buffer = '', total = 0, sequence = 0;
  const pending = new Map(), expired = new Set(), decoder = new StringDecoder('utf8');
  const fail = () => {
    dead = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failed()); }
    pending.clear();
  };
  const write = data => {
    if (dead) throw failed();
    child.stdin.write(`${JSON.stringify(data)}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (dead) { reject(failed()); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id); expired.add(id); reject(failed());
    }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); } catch { fail(); }
  });
  // Desktop clients may use ordinary strings for their message IDs. Only our
  // eventId is constrained to a UUID; unrelated queued prompts must remain valid.
  const validSubmission = entry => object(entry) && uuid(entry.id) && typeof entry.clientUserMessageId === 'string' &&
    Array.isArray(entry.input);
  const findQueued = async () => {
    let cursor, found;
    const cursors = new Set(), ids = new Set();
    for (let page = 0; page < 20; page++) {
      const result = await request('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!object(result) || !Array.isArray(result.data) || result.data.length > 100 ||
          (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !result.nextCursor))) throw failed();
      for (const entry of result.data) {
        if (!validSubmission(entry) || ids.has(entry.id)) throw failed();
        ids.add(entry.id);
        if (entry.clientUserMessageId === eventId) {
          if (found) throw failed();
          found = entry.id;
        }
      }
      cursor = result.nextCursor;
      if (cursor == null) return found;
      if (cursors.has(cursor)) throw failed();
      cursors.add(cursor);
    }
    throw failed();
  };
  try {
    const env = codexEnvironment();
    for (const key of Object.keys(env)) if (/(?:^|_)API_KEY$|^OPENAI_ADMIN_KEY$/i.test(key)) delete env[key];
    child = spawnFn(command, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env,
    });
    child.on('error', fail); child.on('exit', fail);
    child.stdin.on('error', fail); child.stdout.on('error', fail); child.stdout.on('end', fail);
    child.stderr.on('error', () => {}); child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (dead) return;
      try {
        total += Buffer.byteLength(chunk);
        if (total > MAX_OUTPUT) throw failed();
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > MAX_FRAME) throw failed();
          if (!line.trim()) continue;
          const data = JSON.parse(line);
          if (!object(data)) throw failed();
          if ('method' in data) {
            // This connection never runs tasks or grants tool/approval requests.
            if (typeof data.method !== 'string' || 'id' in data) throw failed();
            continue;
          }
          if (!Number.isSafeInteger(data.id) || (('result' in data) === ('error' in data))) throw failed();
          const item = pending.get(data.id);
          if (!item) { if (expired.has(data.id)) continue; throw failed(); }
          pending.delete(data.id); clearTimeout(item.timer);
          if ('error' in data) item.reject(failed()); else item.resolve(data.result);
        }
        if (Buffer.byteLength(buffer) > MAX_FRAME) throw failed();
      } catch { fail(); }
    });
    deadline = setTimeout(fail, timeoutMs);
    const initialized = await request('initialize', {
      clientInfo: { name: 'enigma_host_wake', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!object(initialized)) throw failed();
    write({ method: 'initialized', params: {} });
    const account = await request('account/read', { refreshToken: false });
    if (account?.account?.type !== 'chatgpt') throw failed();
    const existing = await findQueued();
    if (existing) return { status: 'queued', queuedSubmissionId: existing };
    if (reconcileOnly) return { status: 'uncertain' };
    try {
      const result = await request('thread/queue/add', {
        threadId, clientUserMessageId: eventId, input: [{ type: 'text', text: message, text_elements: [] }],
      });
      const entry = result?.queuedSubmission;
      if (!validSubmission(entry) || entry.clientUserMessageId !== eventId || entry.input.length !== 1 ||
          entry.input[0]?.type !== 'text' || entry.input[0]?.text !== message) throw failed();
      return { status: 'queued', queuedSubmissionId: entry.id };
    } catch {
      // A lost response may follow a successful add. Reconcile once; never resend.
      const recovered = await findQueued();
      return recovered ? { status: 'queued', queuedSubmissionId: recovered } : { status: 'uncertain' };
    }
  } catch { return { status: 'uncertain' }; }
  finally {
    clearTimeout(deadline); fail();
    if (child) {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    }
  }
}
