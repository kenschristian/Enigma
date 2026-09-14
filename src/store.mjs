import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { taskKind, slackThreadKey } from './executors.mjs';

const statuses = new Set(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);
const metadata = ['codexThreadId', 'worktreePath', 'branch'];
const mutable = new Set(['status', ...metadata, 'result', 'error']);
const fields = ['eventId', 'conversationKey', 'role', 'prompt', 'channel', 'slackThreadTs', 'userId', 'teamId', 'botKey'];
const decode = (row) => row ? JSON.parse(row.data) : null;
const decodeTask = (row) => {
  const task = decode(row);
  if (task) { task.projectIdentity ??= null; task.kind = taskKind(task); }
  return task;
};

function limitValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error('Invalid result limit');
  return value;
}

export class TaskStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, sequence);
      CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_key, sequence);
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_executors (
        thread_key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        taskId TEXT,
        botKey TEXT NOT NULL,
        channel TEXT NOT NULL,
        threadTs TEXT,
        notifyUserId TEXT,
        prUrl TEXT,
        text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        deliveredAt INTEGER,
        nextAttemptAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_destination ON outbox(botKey, channel, threadTs, sequence)
        WHERE deliveredAt IS NULL;
    `);
    // Serialize discovery and migration with other runner/helper processes.
    // Existing queued messages retain every field; new metadata defaults to null.
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(outbox)').all();
      if (!columns.some(column => column.name === 'notifyUserId')) {
        this.db.exec('ALTER TABLE outbox ADD COLUMN notifyUserId TEXT');
      }
      if (!columns.some(column => column.name === 'prUrl')) {
        this.db.exec('ALTER TABLE outbox ADD COLUMN prUrl TEXT');
      }
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(input) { return this.transaction(() => this.#insertTask(input)); }

  // Persist the action, ownership and response together before Slack acknowledges it.
  enqueueWithReply(input, response) {
    return this.transaction(() => {
      const result = this.#insertTask(input);
      if (result.created) for (const text of response(result.task)) this.addOutbox({
        taskId: result.task.id, botKey: input.botKey, channel: input.channel, threadTs: input.slackThreadTs, text,
      });
      return result;
    });
  }

  threadExecutor(input) {
    const saved = decode(this.db.prepare('SELECT data FROM thread_executors WHERE thread_key = ?').get(slackThreadKey(input)));
    if (saved) return saved;
    // Legacy coding history blocks switching, even if completed or cancelled: saved
    // changes and native session inactivity cannot be established by this listener.
    const prior = decodeTask(this.db.prepare(`SELECT data FROM tasks WHERE
      json_extract(data, '$.teamId') = ? AND json_extract(data, '$.channel') = ?
      AND json_extract(data, '$.slackThreadTs') = ? AND conversation_key NOT LIKE '%:control'
      AND COALESCE(json_extract(data, '$.kind'), 'coding') = 'coding' ORDER BY sequence LIMIT 1`)
      .get(input.teamId, input.channel, input.slackThreadTs));
    return prior ? { executor: 'codex', projectIdentity: prior.projectIdentity, legacy: true } : null;
  }

  executorConflict(input, executor) {
    const owner = this.threadExecutor(input);
    if (!owner) return null;
    if (owner.executor !== executor) return owner.executor === 'devin' ? 'THREAD_RESERVED_DEVIN' : 'THREAD_RESERVED_CODEX';
    // Existing Codex project/worktree verification stays in the execution path.
    if (executor === 'devin' && owner.projectIdentity !== (input.projectIdentity ?? null)) return 'PROJECT_MAPPING_CHANGED';
    return null;
  }

  #insertTask(input) {
    for (const field of fields) {
      if (typeof input[field] !== 'string' || !input[field]) throw new Error(`Missing task field: ${field}`);
    }
    if (input.projectIdentity !== undefined && (typeof input.projectIdentity !== 'string' || !input.projectIdentity.trim() || input.projectIdentity.length > 1024)) {
      throw new Error('Invalid task project identity');
    }
    const kind = taskKind(input);
    if (!['coding', 'control', 'devin-selection', 'devin-prompt'].includes(kind)) throw new Error('Invalid task kind');
    {
      const previous = decodeTask(this.db.prepare('SELECT data FROM tasks WHERE event_id = ?').get(input.eventId));
      if (previous) return { created: false, task: previous };
      const executor = kind === 'coding' ? 'codex' : kind.startsWith('devin-') ? 'devin' : null;
      const conflict = executor && this.executorConflict(input, executor);
      if (executor && !conflict && !this.threadExecutor(input)) {
        this.db.prepare('INSERT INTO thread_executors (thread_key, data) VALUES (?, ?)').run(slackThreadKey(input), JSON.stringify({
          executor, projectIdentity: input.projectIdentity ?? null, selectedByUserId: input.userId, sourceEventId: input.eventId, createdAt: Date.now(),
        }));
      }
      const conversation = this.conversation(input.conversationKey);
      const now = Date.now();
      const task = { id: randomUUID(), kind, status: kind === 'coding' ? (conflict ? 'cancelled' : 'queued') : 'completed', createdAt: now, updatedAt: now, result: null, error: conflict || null, projectIdentity: input.projectIdentity ?? null };
      for (const field of fields) task[field] = input[field];
      for (const field of metadata) task[field] = kind === 'coding' ? conversation?.[field] ?? null : null;
      this.db.prepare('INSERT INTO tasks (id, event_id, conversation_key, status, data) VALUES (?, ?, ?, ?, ?)')
        .run(task.id, task.eventId, task.conversationKey, task.status, JSON.stringify(task));
      return { created: true, task };
    }
  }

  get(id) {
    return decodeTask(this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
  }

  list({ status, limit = 20 } = {}) {
    limitValue(limit);
    if (status !== undefined && !statuses.has(status)) throw new Error('Invalid task status');
    const rows = status === undefined
      ? this.db.prepare('SELECT data FROM tasks ORDER BY sequence DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT data FROM tasks WHERE status = ? ORDER BY sequence DESC LIMIT ?').all(status, limit);
    return rows.map(decodeTask);
  }

  nextQueued() {
    return decodeTask(this.db.prepare(`SELECT queued.data FROM tasks queued
      WHERE queued.status = 'queued' AND NOT EXISTS (
        SELECT 1 FROM tasks active WHERE active.conversation_key = queued.conversation_key AND active.status = 'running'
      ) ORDER BY queued.sequence LIMIT 1`).get());
  }

  interruptedTask(conversationKey, exceptId = '') {
    return decodeTask(this.db.prepare("SELECT data FROM tasks WHERE conversation_key = ? AND status = 'interrupted' AND id != ? ORDER BY sequence LIMIT 1").get(conversationKey, exceptId));
  }

  hasLaterActiveTask(id) {
    return !!this.db.prepare(`SELECT 1 FROM tasks newer JOIN tasks original
      ON newer.conversation_key = original.conversation_key AND newer.sequence > original.sequence
      WHERE original.id = ? AND newer.status NOT IN ('cancelled', 'failed') LIMIT 1`).get(id);
  }

  update(id, patch) {
    for (const field of Object.keys(patch)) {
      if (!mutable.has(field)) throw new Error(`Task field cannot be updated: ${field}`);
    }
    if ('status' in patch && !statuses.has(patch.status)) throw new Error('Invalid task status');
    for (const field of metadata) {
      if (field in patch && patch[field] !== null && (typeof patch[field] !== 'string' || !patch[field])) {
        throw new Error(`Invalid task metadata: ${field}`);
      }
    }
    return this.transaction(() => {
      const task = this.get(id);
      if (!task) throw new Error('Task not found');
      if (['queued', 'running'].includes(patch.status)) {
        if (task.kind !== 'coding') throw new Error('Only coding tasks can run');
        const conflict = this.executorConflict(task, 'codex');
        if (conflict) throw Object.assign(new Error('Thread executor prevents coding.'), { code: conflict });
      }
      if (patch.status === 'running' && this.db.prepare(
        "SELECT 1 FROM tasks WHERE conversation_key = ? AND status = 'running' AND id != ?"
      ).get(task.conversationKey, id)) throw new Error('Conversation already running');
      Object.assign(task, patch, { updatedAt: Date.now() });
      this.db.prepare('UPDATE tasks SET status = ?, data = ? WHERE id = ?').run(task.status, JSON.stringify(task), id);
      if (metadata.some((field) => field in patch)) {
        const saved = decode(this.db.prepare('SELECT data FROM conversations WHERE conversation_key = ?').get(task.conversationKey)) ?? {};
        if (saved.projectIdentity && task.projectIdentity && saved.projectIdentity !== task.projectIdentity) {
          throw Object.assign(new Error('Saved conversation belongs to another project.'), { code: 'PROJECT_MAPPING_CHANGED' });
        }
        saved.projectIdentity = task.projectIdentity ?? saved.projectIdentity ?? null;
        for (const field of metadata) if (field in patch) saved[field] = patch[field];
        this.db.prepare(`INSERT INTO conversations (conversation_key, data) VALUES (?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET data = excluded.data`).run(task.conversationKey, JSON.stringify(saved));
      }
      return task;
    });
  }

  conversation(key) {
    const latest = decodeTask(this.db.prepare('SELECT data FROM tasks WHERE conversation_key = ? ORDER BY sequence DESC LIMIT 1').get(key));
    if (!latest) return null;
    const saved = decode(this.db.prepare('SELECT data FROM conversations WHERE conversation_key = ?').get(key));
    // The newest queued task may belong to a newly mapped project. Its identity
    // must not relabel metadata saved by an earlier task. Older metadata remains
    // explicitly unbound until its exact worktree has been checked by the service.
    return Object.assign(latest, saved, { projectIdentity: saved ? saved.projectIdentity ?? null : latest.projectIdentity });
  }

  recoverInterrupted() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT data FROM tasks WHERE status = 'running'").all();
      const statement = this.db.prepare("UPDATE tasks SET status = 'interrupted', data = ? WHERE id = ?");
      for (const row of rows) {
        const task = decodeTask(row);
        task.status = 'interrupted';
        task.updatedAt = Date.now();
        statement.run(JSON.stringify(task), task.id);
      }
      return rows.length;
    });
  }

  addOutbox({ taskId = null, botKey, channel, threadTs = null, text, notifyUserId = null, prUrl = null }) {
    for (const value of [botKey, channel, text]) {
      if (typeof value !== 'string' || !value) throw new Error('Invalid outbox message');
    }
    if (notifyUserId !== null && (typeof notifyUserId !== 'string' || !/^[UW][A-Z0-9]+$/.test(notifyUserId))) {
      throw new Error('Invalid outbox notification user');
    }
    if (prUrl !== null && (typeof prUrl !== 'string' || prUrl.trim() !== prUrl || !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!(?:\.|\.\.)\/)[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,19}$/.test(prUrl))) {
      throw new Error('Invalid outbox pull request URL');
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO outbox (id, taskId, botKey, channel, threadTs, text, notifyUserId, prUrl, createdAt, nextAttemptAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, botKey, channel, threadTs, text, notifyUserId, prUrl, now, now);
    return { ...this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) };
  }

  pendingOutbox(limit = 20) {
    // Return only the oldest undelivered message per destination. Later chunks
    // cannot overtake it, including while a previously fetched send is failing.
    return this.db.prepare(`SELECT message.* FROM outbox message
      WHERE message.deliveredAt IS NULL AND message.nextAttemptAt <= ?
      AND NOT EXISTS (
        SELECT 1 FROM outbox earlier WHERE earlier.deliveredAt IS NULL
          AND earlier.botKey = message.botKey AND earlier.channel = message.channel
          AND earlier.threadTs IS message.threadTs AND earlier.sequence < message.sequence
      ) ORDER BY message.sequence LIMIT ?`).all(Date.now(), limitValue(limit)).map((row) => ({ ...row }));
  }

  markDelivered(id) {
    this.db.prepare('UPDATE outbox SET deliveredAt = ? WHERE id = ? AND deliveredAt IS NULL').run(Date.now(), id);
  }

  failDelivery(id, minimumDelayMs = 0) {
    const minimum = Math.max(0, Math.min(300000, Number(minimumDelayMs) || 0));
    this.db.prepare(`UPDATE outbox SET attempts = attempts + 1,
      nextAttemptAt = ? + MAX(?, MIN(300000, 1000 * (1 << MIN(attempts, 9))))
      WHERE id = ? AND deliveredAt IS NULL`).run(Date.now(), minimum, id);
  }

  close() {
    this.db.close();
  }
}
