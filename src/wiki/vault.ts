import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WikiNote, WikiSearchResult } from './types.js';
import { WikiDatabase } from './db.js';
import { getEmbeddingProvider } from './embeddings.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'untitled-note';
}

export function getWikiRoot(): string {
  const envDir = (globalThis as any).process?.env?.WIKI_DIR;
  if (envDir) return resolve(envDir);
  return resolve(process.cwd(), 'wiki');
}

let dbInstance: WikiDatabase | null = null;
function getDatabase(): WikiDatabase {
  if (!dbInstance) {
    const root = getWikiRoot();
    const dbPath = join(root, '.index.db');
    dbInstance = new WikiDatabase(dbPath);
  }
  return dbInstance;
}

export interface SaveNoteOptions {
  tags?: string[];
  source?: string;
  inbox?: boolean;
}

export async function saveToWiki(
  title: string,
  content: string,
  options: SaveNoteOptions = {}
): Promise<WikiNote> {
  const root = getWikiRoot();
  const subDir = options.inbox !== false ? 'inbox' : 'notes';
  const targetDir = join(root, subDir);
  mkdirSync(targetDir, { recursive: true });

  const slug = slugify(title);
  const filePath = join(targetDir, `${slug}.md`);
  const now = new Date().toISOString();
  const tags = options.tags || ['note'];

  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    'type: note',
    `tags: ${JSON.stringify(tags)}`,
    `created: "${now}"`,
    options.source ? `source: "${options.source}"` : null,
    '---',
    '',
    content,
  ].filter(Boolean).join('\n');

  writeFileSync(filePath, frontmatter, 'utf8');

  const note: WikiNote = {
    id: slug,
    slug,
    title,
    path: filePath,
    content,
    tags,
    source: options.source,
    createdAt: now,
    updatedAt: now,
  };

  // Embed and index note in SQLite
  try {
    const provider = getEmbeddingProvider();
    const [vector] = await provider.embed([`${title}\n${content}`]);
    const db = getDatabase();
    db.upsertNote(note, vector);
  } catch (err) {
    console.error('Failed to embed wiki note:', err);
  }

  return note;
}

export async function searchWiki(query: string, limit = 5): Promise<WikiSearchResult[]> {
  const provider = getEmbeddingProvider();
  const [queryVector] = await provider.embed([query]);
  const db = getDatabase();
  return db.searchVectors(queryVector, limit);
}
