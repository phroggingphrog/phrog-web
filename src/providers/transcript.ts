import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

export interface TranscriptSegment { start: number; text: string }
export interface Transcript {
  url: string;
  title: string;
  channel?: string;
  duration?: number;
  lang: string;
  source: 'manual' | 'auto' | 'stt';
  stt_model?: string;
  text: string;
  segments: TranscriptSegment[];
}

function run(bin: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
        reject(new Error(`yt-dlp failed: ${msg || err.message}`));
      } else resolve(stdout);
    });
  });
}

function clean(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseJson3(raw: string): TranscriptSegment[] {
  const data = JSON.parse(raw) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  const out: TranscriptSegment[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs) continue;
    const text = clean(ev.segs.map((s) => s.utf8 ?? '').join(''));
    if (text) out.push({ start: (ev.tStartMs ?? 0) / 1000, text });
  }
  return out;
}

function parseVtt(raw: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const start = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const text = clean(lines.slice(i + 1).join(' '));
    if (text) out.push({ start, text });
  }
  return out;
}

// Drop consecutive duplicates and rolling-caption overlap.
function dedupe(segs: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && (prev.text === s.text || prev.text.endsWith(s.text))) continue;
    if (prev && s.text.startsWith(prev.text)) {
      prev.text = s.text;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

async function getCaptionTranscript(
  url: string,
  opts: { lang?: string; maxChars?: number } = {},
): Promise<Transcript> {
  const lang = opts.lang ?? 'en';
  const bin = process.env.YT_DLP_PATH || 'yt-dlp';
  const dir = await mkdtemp(join(tmpdir(), 'transcript-'));
  try {
    const stdout = await run(bin, [
      '--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-langs', `${lang},${lang}-orig`,
      '--sub-format', 'json3/vtt',
      '--no-playlist', '--no-warnings',
      '-o', join(dir, '%(id)s'),
      '--print-json',
      url,
    ]);
    const info = JSON.parse(stdout.trim().split('\n')[0]) as {
      id: string; title?: string; channel?: string; uploader?: string; duration?: number;
      subtitles?: Record<string, unknown>;
    };
    const files = (await readdir(dir)).filter((f) => f.startsWith(info.id + '.'));
    if (!files.length) throw new Error(`No subtitles or captions available for ${url} (lang=${lang})`);

    const manualLangs = new Set(Object.keys(info.subtitles ?? {}));
    const parsed = files.map((f) => {
      const m = f.slice(info.id.length + 1).match(/^(.+)\.(json3|vtt)$/);
      return { f, lang: m?.[1] ?? lang, ext: m?.[2] ?? '', manual: manualLangs.has(m?.[1] ?? '') };
    }).filter((p) => p.ext);
    // manual first, then json3 over vtt, then shortest lang code
    parsed.sort((a, b) =>
      Number(b.manual) - Number(a.manual) ||
      Number(b.ext === 'json3') - Number(a.ext === 'json3') ||
      a.lang.length - b.lang.length);
    const pick = parsed[0];
    if (!pick) throw new Error(`No subtitles or captions available for ${url} (lang=${lang})`);

    const raw = await readFile(join(dir, pick.f), 'utf8');
    const segments = dedupe(pick.ext === 'json3' ? parseJson3(raw) : parseVtt(raw));
    if (!segments.length) throw new Error(`Subtitle file was empty for ${url}`);
    let text = segments.map((s) => s.text).join(' ');
    if (opts.maxChars && text.length > opts.maxChars) text = text.slice(0, opts.maxChars);

    return {
      url,
      title: info.title ?? '',
      channel: info.channel ?? info.uploader,
      duration: info.duration,
      lang: pick.lang,
      source: pick.manual ? 'manual' : 'auto',
      text,
      segments,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- Speech-to-text fallback (OpenAI-compatible /audio/transcriptions, e.g. OmniRoute) ----

const STT_MAX_BYTES = 20 * 1024 * 1024;
const STT_CHUNK_SECONDS = 600;
const NO_CAPTIONS = /No subtitles or captions|Subtitle file was empty/;

function sttConfig() {
  loadConfig();
  const baseUrl = (process.env.STT_BASE_URL || process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/+$/, '');
  const apiKey = process.env.STT_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const model = process.env.STT_MODEL || 'openrouter/openai/whisper-large-v3-turbo';
  return { baseUrl, apiKey, model };
}

async function transcribeFile(
  file: string,
  cfg: ReturnType<typeof sttConfig>,
  lang: string | undefined,
  offset: number,
): Promise<TranscriptSegment[]> {
  const audio = await readFile(file);
  const post = (language?: string) => {
    const form = new FormData();
    form.set('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
    form.set('model', cfg.model);
    form.set('response_format', 'verbose_json');
    if (language) form.set('language', language);
    return fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
    });
  };
  // Whisper wants a bare ISO-639 code ("pt", not "pt-BR"); an unknown code must not sink the request.
  const primary = lang?.split(/[-_]/)[0].toLowerCase();
  let res = await post(primary);
  if (res.status === 400 && primary) res = await post(undefined);
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string; segments?: { start: number; text: string }[] };
  const segs = (data.segments ?? [])
    .map((s) => ({ start: offset + (s.start ?? 0), text: clean(s.text ?? '') }))
    .filter((s) => s.text);
  if (segs.length) return segs;
  const text = clean(data.text ?? '');
  return text ? [{ start: offset, text }] : [];
}

export async function transcribeYoutubeAudio(
  url: string,
  opts: { lang?: string; maxChars?: number } = {},
): Promise<Transcript> {
  const cfg = sttConfig();
  const bin = process.env.YT_DLP_PATH || 'yt-dlp';
  const dir = await mkdtemp(join(tmpdir(), 'stt-'));
  try {
    const stdout = await run(bin, [
      '-x', '--audio-format', 'mp3', '--audio-quality', '9',
      '--no-playlist', '--no-warnings', '-q',
      '-o', join(dir, '%(id)s.%(ext)s'),
      '--print-json',
      url,
    ], 600_000);
    const info = JSON.parse(stdout.trim().split('\n')[0]) as {
      id: string; title?: string; channel?: string; uploader?: string; duration?: number;
    };
    const audio = join(dir, `${info.id}.mp3`);
    const size = (await stat(audio)).size;

    let segments: TranscriptSegment[] = [];
    if (size <= STT_MAX_BYTES) {
      segments = await transcribeFile(audio, cfg, opts.lang, 0);
    } else {
      await run('ffmpeg', [
        '-v', 'error', '-i', audio, '-f', 'segment', '-segment_time', String(STT_CHUNK_SECONDS),
        '-c', 'copy', join(dir, 'part_%04d.mp3'),
      ], 300_000);
      const parts = (await readdir(dir)).filter((f) => /^part_\d+\.mp3$/.test(f)).sort();
      for (let i = 0; i < parts.length; i++) {
        segments.push(...(await transcribeFile(join(dir, parts[i]), cfg, opts.lang, i * STT_CHUNK_SECONDS)));
      }
    }
    if (!segments.length) throw new Error(`Speech-to-text returned no text for ${url}`);

    let text = segments.map((s) => s.text).join(' ');
    if (opts.maxChars && text.length > opts.maxChars) text = text.slice(0, opts.maxChars);
    return {
      url,
      title: info.title ?? '',
      channel: info.channel ?? info.uploader,
      duration: info.duration,
      lang: opts.lang ?? 'auto',
      source: 'stt',
      stt_model: cfg.model,
      text,
      segments,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Captions first; falls back to speech-to-text when none exist. stt: 'auto' (default) | 'off' | 'force'. */
export async function getTranscript(
  url: string,
  opts: { lang?: string; maxChars?: number; stt?: 'auto' | 'off' | 'force' } = {},
): Promise<Transcript> {
  const mode = opts.stt ?? 'auto';
  if (mode === 'force') return transcribeYoutubeAudio(url, opts);
  try {
    return await getCaptionTranscript(url, opts);
  } catch (err) {
    if (mode === 'off' || !(err instanceof Error) || !NO_CAPTIONS.test(err.message)) throw err;
    return transcribeYoutubeAudio(url, opts);
  }
}
