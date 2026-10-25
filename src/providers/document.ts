// PDF / Office to text using host tools: pdftotext for PDF, Python MarkItDown (existing venv) for Office.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const OFFICE: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
};

export function documentKind(url: string, contentType: string): string | null {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf') return '.pdf';
  if (OFFICE[ct]) return OFFICE[ct];
  if (ct && ct !== 'application/octet-stream') return null;
  const path = new URL(url).pathname.toLowerCase();
  return ['.pdf', '.docx', '.xlsx', '.pptx'].find((e) => path.endsWith(e)) ?? null;
}

export function run(cmd: string, args: string[], input: Buffer, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(0, 200)}`)); });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

export const pyPath = () =>
  process.env.PHROG_WEB_PYTHON || fileURLToPath(new URL("../../engines/.venv/bin/python", import.meta.url));

export async function convertDocument(ext: string, body: Buffer): Promise<{ title: string; markdown: string }> {
  if (ext === '.pdf') {
    const text = await run('pdftotext', ['-layout', '-', '-'], body);
    return { title: '', markdown: text.replace(/\n{3,}/g, '\n\n').trim() };
  }
  const py = pyPath();
  if (!existsSync(py)) throw new Error('Office conversion needs a Python with markitdown (set PHROG_WEB_PYTHON)');
  const code = 'import sys,io;from markitdown import MarkItDown,StreamInfo;r=MarkItDown(enable_plugins=False).convert_stream(io.BytesIO(sys.stdin.buffer.read()),stream_info=StreamInfo(extension=sys.argv[1]));print(r.markdown)';
  const md = await run(py, ['-I', '-c', code, ext], body);
  return { title: '', markdown: md.trim() };
}

// Main-content extraction via Trafilatura (same Python venv); null on any failure so the caller can fall back.
export async function extractMain(html: string, url: string): Promise<{ title: string; markdown: string } | null> {
  const py = pyPath();
  if (!existsSync(py)) return null;
  const code = 'import sys,json,trafilatura as t;h=sys.stdin.buffer.read().decode("utf-8","replace");m=t.extract(h,url=sys.argv[1],output_format="markdown",include_links=True,include_tables=True,favor_recall=True);md=t.extract_metadata(h);print(json.dumps({"title":(md.title if md else "") or "","markdown":m or ""}))';
  try {
    const out = JSON.parse(await run(py, ['-I', '-c', code, url], Buffer.from(html, 'utf8'), 10000));
    return out.markdown && out.markdown.length >= 150 ? out : null;
  } catch { return null; }
}
