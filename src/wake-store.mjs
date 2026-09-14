import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync,lstatSync } from 'node:fs';

export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Private delivery journal, separate from coding tasks and the host review ledger. */
export class WakeStore {
  constructor(file, threadId) {
    if (!uuid(threadId)) throw new Error('Invalid host task ID.');
    if(file!==':memory:' && existsSync(file)) {
      const stat=lstatSync(file);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) throw new Error('Wake journal must be a regular private file.');
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS wake_target (singleton INTEGER PRIMARY KEY CHECK(singleton=1), thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wake_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, event_key TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', queue_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, notified INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS wake_pending ON wake_events(status,sequence);`);
    try {
      this.db.prepare('INSERT OR IGNORE INTO wake_target VALUES (1,?)').run(threadId);
      if (this.db.prepare('SELECT thread_id FROM wake_target').get().thread_id !== threadId) {
        throw new Error('Wake journal belongs to a different host task. Preserve it and review the mapping.');
      }
    } catch (error) { this.db.close(); throw error; }
  }
  add(key, payload) {
    if (typeof key !== 'string' || key.length > 512 || !payload || JSON.stringify(payload).length > 4096) throw new Error('Invalid wake event.');
    const now = Date.now();
    this.db.prepare('INSERT OR IGNORE INTO wake_events(id,event_key,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), key, JSON.stringify(payload), now, now);
    return this.decode(this.db.prepare('SELECT * FROM wake_events WHERE event_key=?').get(key));
  }
  decode(row) { return row ? { ...row, payload: JSON.parse(row.payload) } : null; }
  get(id) { if (!uuid(id)) throw new Error('Invalid event ID.'); return this.decode(this.db.prepare('SELECT * FROM wake_events WHERE id=?').get(id)); }
  pending() { return this.db.prepare("SELECT * FROM wake_events WHERE status IN ('pending','attempting') ORDER BY sequence LIMIT 50").all().map(row => this.decode(row)); }
  attempt(id) {
    return this.db.prepare("UPDATE wake_events SET status='attempting',updated_at=? WHERE id=? AND status='pending'").run(Date.now(),id).changes === 1;
  }
  queued(id, queueId) {
    if (!uuid(queueId)) throw new Error('Invalid queued submission ID.');
    // A fast host can acknowledge before the queue response is saved. Never downgrade it.
    this.db.prepare("UPDATE wake_events SET queue_id=?,status=CASE WHEN status='attempting' THEN 'queued' ELSE status END,updated_at=? WHERE id=?")
      .run(queueId, Date.now(), id);
  }
  blocked(id, code) {
    this.db.prepare("UPDATE wake_events SET status='blocked',error=?,updated_at=? WHERE id=? AND status IN ('pending','attempting')")
      .run(code, Date.now(), id);
  }
  acknowledge(id) {
    if (!this.get(id)) throw new Error('Wake event not found.');
    this.db.prepare("UPDATE wake_events SET status='acknowledged',updated_at=? WHERE id=? AND status IN ('attempting','queued','blocked')").run(Date.now(),id);
    return this.get(id);
  }
  finish(id) {
    if (!this.get(id)) throw new Error('Wake event not found.');
    this.db.prepare("UPDATE wake_events SET status='handled',updated_at=? WHERE id=? AND status='acknowledged'").run(Date.now(),id);
    return this.get(id);
  }
  needsNotice() { return this.db.prepare("SELECT * FROM wake_events WHERE status='blocked' AND notified=0 ORDER BY sequence LIMIT 50").all().map(row => this.decode(row)); }
  noticed(id) { this.db.prepare('UPDATE wake_events SET notified=1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
