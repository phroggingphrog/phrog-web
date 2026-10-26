import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { jevConfig } from '../config.js';

export const LEVELS = ['none', 'low', 'medium', 'high'] as const;
const MEDIUM = LEVELS.indexOf('medium');
const MAX_SUMMARY_CHARS = 8000;

export interface PreferenceSummary { text: string; version: string }

/** Owner's own taste text from the private taste file (PHROG_TASTE_FILE); empty when not configured. */
export function readTaste(): string {
  const f = jevConfig().tasteFile;
  return f && existsSync(f) ? readFileSync(f, 'utf8').trim().slice(0, MAX_SUMMARY_CHARS) : '';
}

/**
 * Preference summary used by Jev. With a DB, the stored data-derived summary (see preferences.ts) wins once one has been built;
 * otherwise the taste text alone. Version = first 12 hex of sha256 of the text, so any change in tastes invalidates Jev's cache.
 */
export function preferenceSummary(d?: DatabaseSync): PreferenceSummary {
  const stored = d ? (d.prepare('SELECT version, text FROM preference_summary WHERE id = 1').get() as any) : undefined;
  if (stored) return { text: stored.text, version: stored.version };
  const text = readTaste();
  return { text, version: createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

export interface JevPost {
  caption: string | null;
  author: { handle?: string | null; name?: string | null } | null;
  type: string | null;
  hashtags: string[];
  location: { name?: string | null } | null;
  sponsored: boolean;
  suggested: boolean;
  ocr_text?: string | null;
}

export interface JevScore {
  p_match: number;
  p_engage: number | null;
  confidence: number | null;
  cost_usd: number | null;
  model_version: string;
}

function apiKey(): string {
  const c = jevConfig();
  if (c.keyFile) {
    if (!existsSync(c.keyFile)) throw new Error('PHROG_JEV_KEY_FILE does not exist');
    return readFileSync(c.keyFile, 'utf8').trim();
  }
  if (c.key) return c.key;
  throw new Error('no Jev key: set PHROG_JEV_KEY_FILE or OPENROUTER_API_KEY');
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * One decisions call per post. p_match = P(match level >= "medium") = the summed probability of the
 * medium and high levels of the `match` score question. p_engage = Jev's noul probability that the owner
 * wants to see the post today. confidence is Jev's confidence on the match question.
 */
export async function scorePost(post: JevPost, prefs: PreferenceSummary): Promise<JevScore> {
  const c = jevConfig();
  const noun = post.type === 'event' ? 'event' : 'post';
  const state = {
    post: {
      caption: (post.caption ?? '').slice(0, 1500),
      author: post.author?.handle ?? post.author?.name ?? null,
      type: post.type, hashtags: post.hashtags.slice(0, 20), location: post.location?.name ?? null,
      sponsored: post.sponsored, suggested: post.suggested,
      ...(post.ocr_text ? { ocr_text: post.ocr_text.slice(0, 800) } : {}),
    },
    preferences: prefs.text,
  };
  const questions = {
    match: { type: 'score', instructions: `How well does this ${noun} match the owner's preferences?`, criteria: [...LEVELS] },
    engage: { type: 'noul', instructions: `Would the owner want to see this ${noun} today?` },
  };
  const res = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.model, state, questions }),
    signal: AbortSignal.timeout(60_000),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  let o: any;
  try { o = JSON.parse(bodyText); } catch { throw new Error('Jev returned non-JSON'); }
  const m = o?.answers?.match;
  const probs = m?.probabilities;
  if (!probs || typeof probs !== 'object') throw new Error('Jev reply has no match probabilities');
  let p = 0;
  for (let i = MEDIUM; i < LEVELS.length; i++) p += Number(probs[String(i)] ?? 0) || 0;
  const eng = o.answers?.engage?.noul;
  const cost = o.usage?.cost;
  return {
    p_match: Math.round(clamp01(p) * 1e6) / 1e6,
    p_engage: typeof eng === 'number' ? clamp01(eng) : null,
    confidence: typeof m.confidence === 'number' ? clamp01(m.confidence) : null,
    cost_usd: typeof cost === 'number' ? cost : null,
    model_version: typeof o.model === 'string' ? o.model : c.model,
  };
}
