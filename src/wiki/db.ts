import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { WikiNote, WikiSearchResult } from './types.js';
import { cosineSimilarity } from './embeddings.js';

export class WikiDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        note_id TEXT PRIMARY KEY,
        vector TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
    `);
  }

  upsertNote(note: WikiNote, vector: number[]) {
    const stmt = this.db.prepare(`
      INSERT INTO notes (id, slug, title, path, content, tags, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        tags = excluded.tags,
        source = excluded.source,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      note.id,
      note.slug,
      note.title,
      note.path,
      note.content,
      JSON.stringify(note.tags),
      note.source || null,
      note.createdAt,
      note.updatedAt
    );

    const embedStmt = this.db.prepare(`
      INSERT INTO embeddings (note_id, vector)
      VALUES (?, ?)
      ON CONFLICT(note_id) DO UPDATE SET vector = excluded.vector;
    `);

    embedStmt.run(note.id, JSON.stringify(vector));
  }

  searchVectors(queryVector: number[], limit = 5): WikiSearchResult[] {
    const rows = this.db.prepare(`
      SELECT n.id, n.title, n.path, n.content, n.tags, e.vector
      FROM notes n
      JOIN embeddings e ON n.id = e.note_id
    `).all() as any[];

    const scored: Array<{ id: string; title: string; path: string; similarity: number; snippet: string; tags: string[] }> = [];

    for (const row of rows) {
      try {
        const vec = JSON.parse(row.vector) as number[];
        const sim = cosineSimilarity(queryVector, vec);
        const tags = JSON.parse(row.tags || '[]');
        const snippet = row.content.slice(0, 200).replace(/\s+/g, ' ').trim();

        scored.push({
          id: row.id,
          title: row.title,
          path: row.path,
          similarity: sim,
          snippet,
          tags,
        });
      } catch {}
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  close() {
    this.db.close();
  }
}
