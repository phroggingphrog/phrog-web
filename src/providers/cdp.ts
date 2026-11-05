/**
 * A minimal Chrome DevTools Protocol client — no Playwright, no puppeteer, no new dependency.
 * Node's global WebSocket is enough to drive the Chromium that is already running.
 *
 * Why this exists: crawl4ai's HTTP API refuses `storage_state`, `user_data_dir` and
 * `use_persistent_context` on a per-request BrowserConfig (they are trusted-only config.yml
 * fields), so cookies cannot ride through it. This talks to the browser that genuinely holds
 * the login instead.
 *
 * Lesson baked in: browser-level `Storage.setCookies` writes to a throwaway store and is lost on
 * restart. Cookies MUST be set through `Network.setCookie` inside an attached page session for
 * them to reach the on-disk profile.
 */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function cdpBase(): string {
  return process.env.PHROG_WEB_CDP_URL || 'http://127.0.0.1:9222';
}

interface Rpc {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
}

async function connect(): Promise<Rpc> {
  const version = await (await fetch(`${cdpBase()}/json/version`, { signal: AbortSignal.timeout(5000) })).json() as { webSocketDebuggerUrl: string };
  const sock = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
    sock.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    sock.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sock.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        sock.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method} timed out`)); }
        }, 60000);
      });
    },
    close() { try { sock.close(); } catch { /* already closed */ } },
  };
}

export interface PageResult {
  url: string;
  title: string;
  text: string;
  cookies: string[];
}

/**
 * Open a page, optionally injecting cookies, and read it back as text.
 * Cookies are set BEFORE the first navigation so the site sees a logged-in session immediately.
 */
export async function fetchPage(
  url: string,
  cookies: CdpCookie[] = [],
  opts: { waitMs?: number } = {},
): Promise<PageResult> {
  const rpc = await connect();
  let targetId = '';
  try {
    const created = await rpc.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const { sessionId } = await rpc.send('Target.attachToTarget', { targetId, flatten: true });
    await rpc.send('Network.enable', {}, sessionId);
    if (cookies.length) {
      // One at a time: a single bad cookie should not drop the whole jar.
      for (const c of cookies) {
        try { await rpc.send('Network.setCookie', c as unknown as Record<string, unknown>, sessionId); } catch { /* skip invalid */ }
      }
    }
    await rpc.send('Page.enable', {}, sessionId);
    await rpc.send('Page.navigate', { url }, sessionId);
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 2500)); // let the document settle
    const title = (await rpc.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)).result?.value ?? '';
    const text = (await rpc.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    }, sessionId)).result?.value ?? '';
    const seen = (await rpc.send('Network.getCookies', { urls: [url] }, sessionId)).cookies ?? [];
    return {
      url,
      title: String(title),
      text: String(text),
      cookies: seen.map((c: any) => `${c.name}=${c.value}`),
    };
  } finally {
    if (targetId) { try { await rpc.send('Target.closeTarget', { targetId }); } catch { /* gone */ } }
    rpc.close();
  }
}

/** Read every cookie the persistent profile currently holds for a domain (login export). */
export async function exportCookies(domain: string): Promise<CdpCookie[]> {
  const rpc = await connect();
  let targetId = '';
  try {
    const created = await rpc.send('Target.createTarget', { url: `https://${domain}/` });
    targetId = created.targetId;
    const { sessionId } = await rpc.send('Target.attachToTarget', { targetId, flatten: true });
    await rpc.send('Network.enable', {}, sessionId);
    const all = (await rpc.send('Network.getAllCookies', {}, sessionId)).cookies ?? [];
    const bare = domain.replace(/^\./, '');
    return all
      .filter((c: any) => {
        const d = String(c.domain || '').replace(/^\./, '');
        return d === bare || d.endsWith(`.${bare}`);
      })
      .map((c: any) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      }));
  } finally {
    if (targetId) { try { await rpc.send('Target.closeTarget', { targetId }); } catch { /* gone */ } }
    rpc.close();
  }
}

export async function cdpAlive(): Promise<{ alive: boolean; browser?: string }> {
  try {
    const v = await (await fetch(`${cdpBase()}/json/version`, { signal: AbortSignal.timeout(4000) })).json() as { Browser?: string };
    return { alive: true, browser: v.Browser };
  } catch {
    return { alive: false };
  }
}
