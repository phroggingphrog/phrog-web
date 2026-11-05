// Automatic query shaping.
//
// Why: SearXNG literalises long natural-language prompts. A 20-word prompt that a model
// writes ("melbourne events november 1 2026 november 10 film screening book club volunteer
// writing competition submissions") returns results for the *whole string*, so the page the
// user actually wanted never enters the candidate set — measured at 32/40 real queries.
//
// This runs at the gateway, not in the prompt: the caller cannot be relied on to write short
// queries, and we should not spend a model call to fix punctuation.
//
// Rules kept deliberately boring so the output is explainable:
//   - operators are sacred: site:, filetype:, inurl:, quoted phrases, OR / -term survive intact
//   - stopwords, fillers and duplicated words are dropped, order preserved, cap at MAX_TERMS
//   - technical tokens (digits, dots, slashes, camelCase, ALLCAPS) are never dropped
//   - CJK returns the query untouched: no whitespace tokenisation, so compaction would carve
//     words in half
//   - queries already short and operator-clean are left alone (variants = [])

const STOP = new Set(('a an the and or of for to in on at by with from is are was were be been being ' +
  'do does did how what when where which who why can could should would will shall may might must ' +
  'i me my we our you your it its this that these those there here about into over under again ' +
  'then than so if but not no yes just also very more most some any all each every about vs versus').split(' '));

const OPERATOR = /\b(site|filetype|inurl|intitle|inanchor|related):\S+/gi;
const QUOTED = /"([^"]+)"/g;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const MAX_TERMS = 8;

export interface ShapedQuery {
  /** What actually gets searched first. */
  primary: string;
  /** Extra variants to run in parallel and fuse. Empty means "the query was already fine". */
  variants: string[];
  /** True when shaping changed something — for logging and for the bench. */
  shaped: boolean;
  /** Tokens dropped from the original, for transparency. */
  dropped: string[];
}

const technical = (t: string) => /[\d./_:-]/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z]{2,}$/.test(t);

function terms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/^[("'[]+|[)"'\].,;:!?]+$/g, '');
    if (!t) continue;
    const low = t.toLowerCase();
    const isTech = technical(t);
    if (!isTech && (STOP.has(low) || low.length < 2)) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(t);
  }
  return out;
}

export function shapeQuery(query: string): ShapedQuery {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q || CJK.test(q)) return { primary: q || query, variants: [], shaped: false, dropped: [] };

  const operators = q.match(OPERATOR) || [];
  const phrases = [...q.matchAll(QUOTED)].map((m) => `"${m[1]}"`);
  const bare = q.replace(OPERATOR, ' ').replace(QUOTED, ' ');
  const kept = terms(bare);
  const keptSet = new Set(kept.map((t) => t.toLowerCase()));
  const dropped = bare.split(/\s+/).map((w) => w.replace(/^[("'[]+|[)"'\].,;:!?]+$/g, '')).filter((t) => t && !keptSet.has(t.toLowerCase()));

  // Already tight: few terms, no filler to remove.
  if (kept.length <= 4 && operators.length === 0 && phrases.length === 0) {
    return { primary: q, variants: [], shaped: false, dropped: [] };
  }

  // Quoted phrases are the strongest signal a query carries: they stay in the primary,
  // ahead of the loose terms, and still count against the term budget.
  const budget = Math.max(0, MAX_TERMS - phrases.length);
  const compact = [...phrases, ...kept.slice(0, budget), ...operators].join(' ');
  const primary = compact || q;

  const variants: string[] = [];
  // Phrase-only variant: engines treat an exact phrase differently from a bag of words.
  if (phrases.length) variants.push(phrases.join(' '));
  if (kept.length > MAX_TERMS) variants.push(kept.slice(0, 4).join(' '));
  if (!operators.length) variants.push(kept.slice(0, 3).join(' '));

  const uniq = [...new Set(variants.filter((v) => v && v !== primary && v !== q))].slice(0, 2);
  return { primary, variants: uniq, shaped: primary !== q || uniq.length > 0, dropped };
}
