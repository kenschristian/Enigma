import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const statuses = new Set(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);
const metadata = ['codexThreadId', 'worktreePath', 'branch'];
const mutable = new Set(['status', ...metadata, 'result', 'error']);
const fields = ['eventId', 'conversationKey', 'role', 'prompt', 'channel', 'slackThreadTs', 'userId', 'teamId', 'botKey'];
const decode = (row) => row ? JSON.parse(row.data) : null;

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
      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        taskId TEXT,
        botKey TEXT NOT NULL,
        channel TEXT NOT NULL,
        threadTs TEXT,
        text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        deliveredAt INTEGER,
        nextAttemptAt INTEGER NOT NULL
      );
    `);
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

  enqueue(input) {
    for (const field of fields) {
      if (typeof input[field] !== 'string' || !input[field]) throw new Error(`Missing task field: ${field}`);
    }
    return this.transaction(() => {
      const previous = decode(this.db.prepare('SELECT data FROM tasks WHERE event_id = ?').get(input.eventId));
      if (previous) return { created: false, task: previous };
      const conversation = this.conversation(input.conversationKey);
      const now = Date.now();
      const task = { id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now, result: null, error: null };
      for (const field of fields) task[field] = input[field];
      for (const field of metadata) task[field] = conversation?.[field] ?? null;
      this.db.prepare('INSERT INTO tasks (id, event_id, conversation_key, status, data) VALUES (?, ?, ?, ?, ?)')
        .run(task.id, task.eventId, task.conversationKey, task.status, JSON.stringify(task));
      return { created: true, task };
    });
  }

  get(id) {
    return decode(this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
  }

  list({ status, limit = 20 } = {}) {
    limitValue(limit);
    if (status !== undefined && !statuses.has(status)) throw new Error('Invalid task status');
    const rows = status === undefined
      ? this.db.prepare('SELECT data FROM tasks ORDER BY sequence DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT data FROM tasks WHERE status = ? ORDER BY sequence DESC LIMIT ?').all(status, limit);
    return rows.map(decode);
  }

  nextQueued() {
    return decode(this.db.prepare(`SELECT queued.data FROM tasks queued
      WHERE queued.status = 'queued' AND NOT EXISTS (
        SELECT 1 FROM tasks active WHERE active.conversation_key = queued.conversation_key AND active.status = 'running'
      ) ORDER BY queued.sequence LIMIT 1`).get());
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
      if (patch.status === 'running' && this.db.prepare(
        "SELECT 1 FROM tasks WHERE conversation_key = ? AND status = 'running' AND id != ?"
      ).get(task.conversationKey, id)) throw new Error('Conversation already running');
      Object.assign(task, patch, { updatedAt: Date.now() });
      this.db.prepare('UPDATE tasks SET status = ?, data = ? WHERE id = ?').run(task.status, JSON.stringify(task), id);
      if (metadata.some((field) => field in patch)) {
        const saved = decode(this.db.prepare('SELECT data FROM conversations WHERE conversation_key = ?').get(task.conversationKey)) ?? {};
        for (const field of metadata) if (field in patch) saved[field] = patch[field];
        this.db.prepare(`INSERT INTO conversations (conversation_key, data) VALUES (?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET data = excluded.data`).run(task.conversationKey, JSON.stringify(saved));
      }
      return task;
    });
  }

  conversation(key) {
    const latest = decode(this.db.prepare('SELECT data FROM tasks WHERE conversation_key = ? ORDER BY sequence DESC LIMIT 1').get(key));
    if (!latest) return null;
    const saved = decode(this.db.prepare('SELECT data FROM conversations WHERE conversation_key = ?').get(key));
    return Object.assign(latest, saved);
  }

  recoverInterrupted() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT data FROM tasks WHERE status = 'running'").all();
      const statement = this.db.prepare("UPDATE tasks SET status = 'interrupted', data = ? WHERE id = ?");
      for (const row of rows) {
        const task = decode(row);
        task.status = 'interrupted';
        task.updatedAt = Date.now();
        statement.run(JSON.stringify(task), task.id);
      }
      return rows.length;
    });
  }

  addOutbox({ taskId = null, botKey, channel, threadTs = null, text }) {
    for (const value of [botKey, channel, text]) {
      if (typeof value !== 'string' || !value) throw new Error('Invalid outbox message');
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO outbox (id, taskId, botKey, channel, threadTs, text, createdAt, nextAttemptAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, botKey, channel, threadTs, text, now, now);
    return { ...this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) };
  }

  pendingOutbox(limit = 20) {
    return this.db.prepare(`SELECT * FROM outbox WHERE deliveredAt IS NULL AND nextAttemptAt <= ?
      ORDER BY sequence LIMIT ?`).all(Date.now(), limitValue(limit)).map((row) => ({ ...row }));
  }

  markDelivered(id) {
    this.db.prepare('UPDATE outbox SET deliveredAt = ? WHERE id = ? AND deliveredAt IS NULL').run(Date.now(), id);
  }

  failDelivery(id) {
    this.db.prepare(`UPDATE outbox SET attempts = attempts + 1,
      nextAttemptAt = ? + MIN(300000, 1000 * (1 << MIN(attempts, 9)))
      WHERE id = ? AND deliveredAt IS NULL`).run(Date.now(), id);
  }

  close() {
    this.db.close();
  }
}
