// Optional user location. Set once with `pnpm setup` (PHROG_LOCATION + PHROG_LAT/PHROG_LNG in the env file),
// or pass `near` per call. Nothing is sent anywhere unless a location-aware tool is used.
import { loadConfig } from './config.js';

export interface UserLocation {
  name: string;
  lat?: number;
  lng?: number;
  state?: string;
  country?: string;
}

const cache = new Map<string, UserLocation | null>();

/** Geocode a place name with OpenStreetMap Nominatim (no key; one request, cached). */
export async function geocode(name: string): Promise<UserLocation | null> {
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'phrog-web/0.1 (self-hosted)' }, signal: AbortSignal.timeout(8000) });
    const hit: any = res.ok ? ((await res.json()) as any[])[0] : undefined;
    const loc = hit
      ? { name, lat: Number(hit.lat), lng: Number(hit.lon), state: hit.address?.state, country: hit.address?.country_code?.toUpperCase() }
      : null;
    cache.set(key, loc);
    return loc;
  } catch {
    return null;
  }
}

/** `near` wins; otherwise the saved location; otherwise undefined (tools behave as before). */
export async function resolveLocation(near?: string): Promise<UserLocation | undefined> {
  if (near?.trim()) return (await geocode(near)) ?? { name: near.trim() };
  loadConfig();
  const name = process.env.PHROG_LOCATION?.trim();
  if (!name) return undefined;
  const lat = Number(process.env.PHROG_LAT), lng = Number(process.env.PHROG_LNG);
  return {
    name,
    lat: Number.isFinite(lat) && process.env.PHROG_LAT ? lat : undefined,
    lng: Number.isFinite(lng) && process.env.PHROG_LNG ? lng : undefined,
    state: process.env.PHROG_STATE || undefined,
    country: process.env.PHROG_COUNTRY || undefined,
  };
}

const AU_STATES: Record<string, string> = {
  victoria: 'VIC', 'new south wales': 'NSW', queensland: 'QLD', 'western australia': 'WA',
  'south australia': 'SA', tasmania: 'TAS', 'australian capital territory': 'ACT', 'northern territory': 'NT',
};
export const stateCode = (state?: string) => (state ? AU_STATES[state.toLowerCase()] ?? state.toUpperCase() : undefined);

const LOCAL_INTENT = /\b(near me|nearby|near here|around here|local|in my area|open now|best .* (in|around) ?$)/i;
const LOCAL_TOPIC = /\b(restaurant|cafe|coffee|bar|pub|gym|dentist|doctor|gp|clinic|pharmacy|chemist|mechanic|plumber|electrician|hairdresser|barber|supermarket|shop|store|takeaway|delivery|weather|events?)\b/i;

/** Add the user's place to a web query only when it clearly has local intent and names no place already. */
export function localizeQuery(q: string, loc?: UserLocation): string {
  if (!loc) return q;
  if (!LOCAL_INTENT.test(q) && !(LOCAL_TOPIC.test(q) && /\b(best|good|cheap|top)\b/i.test(q))) return q;
  if (/\b(in|at|near|around)\s+[A-Z]/.test(q.replace(/near me/i, ''))) return q;
  return `${q.replace(/\b(near me|nearby|near here|around here|in my area)\b/i, '').trim()} ${loc.name}`;
}
