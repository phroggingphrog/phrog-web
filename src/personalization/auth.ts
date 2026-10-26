import { createHash, timingSafeEqual } from 'node:crypto';
import { personalConfig } from '../config.js';

export type AuthResult = 'ok' | 'unauthorized' | 'unconfigured';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Check an `Authorization` header value against PHROG_PERSONAL_TOKEN (constant time). */
export function checkBearer(header: string | string[] | undefined): AuthResult {
  const token = personalConfig().token;
  if (!token) return 'unconfigured';
  const h = Array.isArray(header) ? header[0] : header;
  const m = typeof h === 'string' ? /^Bearer (.+)$/i.exec(h.trim()) : null;
  if (!m) return 'unauthorized';
  return timingSafeEqual(digest(m[1]), digest(token)) ? 'ok' : 'unauthorized';
}

/** Stdio MCP is the local owner: allowed whenever the token is set in the environment. */
export const stdioAuthorized = () => !!personalConfig().token;

export const AUTH_REQUIRED_MESSAGE = 'auth_required: the personal feed tool needs the owner bearer token (Authorization: Bearer <PHROG_PERSONAL_TOKEN>)';
