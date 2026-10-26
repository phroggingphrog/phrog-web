import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './migrations.js';

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

export function openPersonalDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Map((db.prepare('SELECT id, checksum FROM schema_migrations').all() as any[]).map((r) => [r.id, r.checksum]));
  for (const m of MIGRATIONS) {
    const sum = checksum(m.sql);
    const have = applied.get(m.id);
    if (have) {
      if (have !== sum) throw new Error(`Migration ${m.id} was changed after it was applied (checksum mismatch)`);
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)').run(m.id, sum, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
