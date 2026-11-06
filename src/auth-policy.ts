import { timingSafeEqual } from 'node:crypto';

/**
 * Which doors require a client token, decided from the path.
 *
 * The first version matched only `req.raw.url`, but find-my-way percent-decodes and strips an absolute-form
 * prefix before routing: `/api/%72esearch/...` reached the handler with no token, and so did `GET /%6Dcp`.
 * Every candidate form of the path is therefore matched, and a path that cannot be decoded is metered.
 */
const METERED: Array<{ re: RegExp; methods?: string[] }> = [
  { re: /^\/mcp(\/|$)/ },
  { re: /^\/api\/(agent|browse|browser|research|crawl|batch)(\/|$)/ },
  // /api/keys can add or delete provider credentials, /api/extract spends an LLM call: their mutations are
  // metered, their reads (key names and plans, never values) stay open.
  { re: /^\/api\/(extract|keys)(\/|$)/, methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
];

/** Client management is admin-only: a client token must never be able to mint another client token. */
export const ADMIN_ONLY = /^\/api\/clients(\/|$)/;

/** Strip the query and any absolute-form prefix (`http://host/path`), which some clients still send. */
export function pathOf(rawUrl: string): string {
  let path = (rawUrl || '/').split('?')[0];
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(.*)$/i.exec(path);
  if (absolute) path = absolute[1] || '/';
  return path || '/';
}

export function decodePath(path: string): string | undefined {
  try { return decodeURIComponent(path); } catch { return undefined; }
}

export function isMetered(rawPath: string, decoded: string | undefined, method: string): boolean {
  const upper = method.toUpperCase();
  const candidates = decoded === undefined ? [rawPath] : [rawPath, decoded];
  return METERED.some(({ re, methods }) => (!methods || methods.includes(upper)) && candidates.some((r) => re.test(r)));
}

export function isAdminOnly(rawPath: string, decoded: string | undefined): boolean {
  return ADMIN_ONLY.test(rawPath) || (decoded !== undefined && ADMIN_ONLY.test(decoded));
}

/** Constant-time compare that does not leak length through an early return. */
export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
