/**
 * Per-site login jars.
 *
 * One JSON file per site at ~/.config/phrog-web/profiles/<site>.json, mode 0600, holding the
 * cookie set exported from the persistent Chromium profile. Fetching a URL with a jar injects
 * those cookies into a real page session (see cdp.ts), so a logged-in page can be read without
 * anyone pasting a password into a service that cannot read the Hermes vault anyway.
 *
 * Deliberately per-site: no profile bleed, one site's cookies can be revoked without touching
 * another, and every jar's age and expiry is visible from GET /api/profiles.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CdpCookie } from './cdp.js';

export function profilesDir(): string {
  return process.env.PHROG_WEB_PROFILES_DIR || resolve(homedir(), '.config/phrog-web/profiles');
}

export interface LoginJar {
  site: string;
  saved_at: string;
  cookies: CdpCookie[];
}

export interface JarSummary {
  site: string;
  saved_at: string;
  cookies: number;
  /** Earliest cookie expiry in the jar, or null when every cookie is a session cookie. */
  earliest_expiry: string | null;
  expired: boolean;
  names: string[];
}

function jarPath(site: string): string {
  const safe = site.toLowerCase().replace(/[^a-z0-9.-]/g, '_');
  return resolve(profilesDir(), `${safe}.json`);
}

/** Registrable-ish site key for a URL: the last two labels (or three for known multi-part TLDs). */
export function siteForUrl(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoPartTlds = new Set(['com.au', 'co.uk', 'co.nz', 'co.jp', 'com.br', 'co.za', 'com.sg', 'co.in']);
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTlds.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export function listJars(): JarSummary[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const jar = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as LoginJar;
        const expiries = jar.cookies.map((c) => c.expires ?? -1).filter((e) => e > 0).sort((a, b) => a - b);
        const earliest = expiries.length ? new Date(expiries[0] * 1000).toISOString() : null;
        return {
          site: jar.site,
          saved_at: jar.saved_at,
          cookies: jar.cookies.length,
          earliest_expiry: earliest,
          expired: !!(earliest && new Date(earliest).getTime() < Date.now()),
          names: jar.cookies.map((c) => c.name).slice(0, 20),
        };
      } catch { return null; }
    })
    .filter((x): x is JarSummary => x !== null)
    .sort((a, b) => a.site.localeCompare(b.site));
}

export function readJar(site: string): LoginJar | null {
  const file = jarPath(site);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as LoginJar; } catch { return null; }
}

export function writeJar(site: string, cookies: CdpCookie[]): LoginJar {
  if (!cookies.length) throw new Error(`no cookies found for ${site}: is that site logged in in the browser?`);
  mkdirSync(profilesDir(), { recursive: true });
  const jar: LoginJar = { site, saved_at: new Date().toISOString(), cookies };
  writeFileSync(jarPath(site), JSON.stringify(jar, null, 2), { mode: 0o600 });
  return jar;
}

export function deleteJar(site: string): boolean {
  const file = jarPath(site);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/**
 * Jar lookup for a URL. `profile` may be true (use the site's own jar) or an explicit site name.
 * Returns null when there is nothing to inject, so callers can fall back to the normal fetch chain.
 */
export function jarForUrl(url: string, profile?: boolean | string): LoginJar | null {
  if (!profile) return null;
  if (typeof profile === 'string') return readJar(profile);
  const site = siteForUrl(url);
  return site ? readJar(site) : null;
}

/** Fetch a page through the Chromium profile that holds the login for that site. */
export async function fetchWithProfile(url: string, opts: { profile?: boolean | string; waitMs?: number } = {}) {
  const jar = jarForUrl(url, opts.profile ?? true);
  if (!jar) {
    const err = new Error(
      `no login jar for ${url}. Log in with the browser, then save one with POST /api/profiles/<site>/save or the login_state MCP tool (action save).`
    ) as Error & { code?: string; known?: string[] };
    err.code = 'NO_JAR';
    err.known = listJars().map((j) => j.site);
    throw err;
  }
  const { fetchPage } = await import('./cdp.js');
  const page = await fetchPage(url, jar.cookies, { waitMs: opts.waitMs });
  return {
    url: page.url,
    title: page.title,
    markdown: page.text,
    length: page.text.length,
    site: jar.site,
    jar_saved_at: jar.saved_at,
    cookies_seen: page.cookies.length,
    provider_used: 'cdp-profile',
  };
}
