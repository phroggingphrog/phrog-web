// Pull event facts out of page text. Only what the text states: anything not found stays null, nothing is guessed.

const TZ = 'Australia/Melbourne';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const DMY = new RegExp(`(?:${WD_RE}\\.?,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON_RE}\\.?(?:,?\\s+(\\d{4}))?`, 'i');
const MDY = new RegExp(`(?:${WD_RE}\\.?,?\\s+)?${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(\\d{4}))?`, 'i');
const TIME = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

export interface ParsedWhen {
  starts_at: string | null; // UTC ISO
  precision: 'minute' | 'day' | 'unknown';
  local: { y: number; m: number; d: number; hh: number | null; mm: number | null } | null;
}

const idx = (names: string[], s: string) => names.indexOf(s.slice(0, 3).toLowerCase());

/** Local Melbourne wall time -> UTC ISO (handles AEST/AEDT by trying both offsets). */
export function melbourneToUtc(y: number, m: number, d: number, hh = 0, mm = 0): string | null {
  const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  for (const off of [10, 11]) {
    const t = Date.UTC(y, m - 1, d, hh - off, mm);
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
    if (p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm) return new Date(t).toISOString();
  }
  return null;
}

function resolveYear(day: number, mon: number, year: number | null, weekday: number | null, now: Date): number | null {
  if (year !== null) return year;
  if (weekday === null) return null; // "8 Nov" alone could be any year: stay unknown
  const y0 = now.getUTCFullYear();
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const dt = new Date(Date.UTC(y, mon - 1, day));
    if (dt.getUTCMonth() === mon - 1 && dt.getUTCDay() === weekday) return y;
  }
  return null;
}

/** First usable date (and time, when stated with am/pm) in the text. Weekday-only years are resolved only when the weekday fixes them. */
export function parseWhen(text: string, now: Date = new Date()): ParsedWhen {
  const anchored = anchorWindows(text);
  for (const chunk of anchored) {
    const r = parseChunk(chunk, now);
    if (r) return r;
  }
  return { starts_at: null, precision: 'unknown', local: null };
}

/** Prefer text right after a "date and time / when / date" label, then the start of the page, then the rest. */
function anchorWindows(text: string): string[] {
  const out: string[] = [];
  const lab = /(date and time|date & time|when|date)\b[:\s]/gi;
  let m: RegExpExecArray | null;
  while ((m = lab.exec(text)) && out.length < 4) out.push(text.slice(m.index, m.index + 160));
  out.push(text.slice(0, 1500));
  return out;
}

function parseChunk(s: string, now: Date): ParsedWhen | null {
  let day: number, mon: number, year: number | null, wd: number | null, end: number;
  const a = DMY.exec(s);
  const b = MDY.exec(s);
  const hit = a && b ? (a.index <= b.index ? 'a' : 'b') : a ? 'a' : b ? 'b' : null;
  if (hit === 'a') { const g = a!; wd = g[1] ? idx(WEEKDAYS, g[1]) : null; day = Number(g[2]); mon = idx(MONTHS, g[3]) + 1; year = g[4] ? Number(g[4]) : null; end = g.index + g[0].length; }
  else if (hit === 'b') { const g = b!; wd = g[1] ? idx(WEEKDAYS, g[1]) : null; mon = idx(MONTHS, g[2]) + 1; day = Number(g[3]); year = g[4] ? Number(g[4]) : null; end = g.index + g[0].length; }
  else return null;
  if (!(day >= 1 && day <= 31 && mon >= 1)) return null;
  const y = resolveYear(day, mon, year, wd, now);
  if (y === null) return null;
  const check = new Date(Date.UTC(y, mon - 1, day));
  if (check.getUTCMonth() !== mon - 1 || (wd !== null && check.getUTCDay() !== wd)) return null; // impossible date or weekday mismatch
  const after = s.slice(end, end + 60);
  // "7 - 10pm": the start has no am/pm. Day precision only; the end's meridiem is not assumed for the start.
  const rangeStart = /^[\s,·•@\-–—]*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(am|pm)?\s*(?:[-–—]|to\b)/i.exec(after);
  const t = rangeStart && !rangeStart[1] ? null : TIME.exec(after);
  if (t) {
    let hh = Number(t[1]) % 12;
    if (t[3].toLowerCase() === 'pm') hh += 12;
    const mm = t[2] ? Number(t[2]) : 0;
    if (Number(t[1]) >= 1 && Number(t[1]) <= 12 && mm < 60) {
      const iso = melbourneToUtc(y, mon, day, hh, mm);
      if (iso) return { starts_at: iso, precision: 'minute', local: { y, m: mon, d: day, hh, mm } };
    }
  }
  // Day only: store the instant of local midnight, flagged day precision.
  const iso = melbourneToUtc(y, mon, day, 0, 0);
  return iso ? { starts_at: iso, precision: 'day', local: { y, m: mon, d: day, hh: null, mm: null } } : null;
}

const strip = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Venue text from a "Location / Venue / Where" label; null when the page has none. */
export function parseVenue(text: string): string | null {
  const m = /(?:^|\n)\s*#{0,4}\s*\**(location|venue|where)\**\s*:?\s*\n?/i.exec(text) ?? /\b(location|venue|where)\s*:\s*/i.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 400).split('\n');
  for (const line of rest) {
    const v = strip(line);
    if (!v || /^(show map|view map|get directions|map|directions)$/i.test(v)) continue;
    const clean = v.replace(/^[;:,\s]+/, '').replace(/\s*(get directions|show map|view map)\s*$/i, '').slice(0, 160);
    return clean && !/^access\b/i.test(clean) ? clean : null;
  }
  return null;
}

/** Search snippets often read "... Saturday, May 16, 2026 at Thornbury Picture House, Thornbury, VIC." */
export function venueFromSnippet(s: string): string | null {
  const m = /(?:\d{4}|\d{1,2}(?::\d{2})?\s*[AP]M)\s+at\s+([^.]{3,120})/i.exec(s);
  return m ? m[1].trim() : null;
}

/** True when the page itself says the event is over. */
export const looksEnded = (t: string) => /\bevent (?:has )?ended\b|\bsales ended\b|\bthis event has (?:finished|passed)\b/i.test(t);

export interface ParsedPrice { min: number | null; max: number | null; currency: string | null; free: boolean }

/** Prices stated on the page. "Free" only when the text says free entry/admission/ticket; amounts only from $-prefixed numbers. */
export function parsePrice(text: string): ParsedPrice {
  const free = /\bfree\s+(?:entry|admission|event|ticket|tickets|to attend)\b|\bticket(?:s)?\s*:?\s*free\b|\badmission\s*:?\s*free\b/i.test(text);
  const amounts = [...text.matchAll(/(?:A\$|AU\$|\$)\s?(\d{1,4}(?:\.\d{2})?)/g)].map((x) => Number(x[1])).filter((n) => n > 0 && n < 2000);
  if (!amounts.length) return { min: free ? 0 : null, max: free ? 0 : null, currency: free ? 'AUD' : null, free };
  const min = free ? 0 : Math.min(...amounts);
  return { min, max: Math.max(...amounts), currency: 'AUD', free };
}

const ONLINE = /\bonline event\b(?!s)|\bvia zoom\b|\bvirtual event\b|\bwebinar\b/i;
export const looksOnline = (t: string) => ONLINE.test(t);

export function cleanTitle(t: string): string {
  return t.replace(/&amp;/g, '&').replace(/\s+tickets?,\s.*$/i, '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s*[|\-–—]\s*(eventbrite(?:\.com(?:\.au)?)?|humanitix)\b.*$/i, '').replace(/\s*(tickets?|tickets? &amp; info)\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function oneLine(md: string, n: number): string {
  return strip(md).slice(0, n);
}
