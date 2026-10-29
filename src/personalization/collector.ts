// Shared feed result types and the cursor format used by the feed endpoint.
export const CURSOR_RE = /^[A-Za-z0-9_\-=:.|+/]{1,4096}$/;

export const COLLECTOR_STATUSES = ['ok', 'end', 'auth_required', 'challenge', 'rate_limited', 'busy', 'unsupported', 'failed'] as const;
export type CollectorStatus = (typeof COLLECTOR_STATUSES)[number];

export interface CollectorResult {
  status: CollectorStatus;
  cursor: string | null;
  next_cursor: string | null;
  fetched_at: string | null;
  error: string | null;
  items: any[];
}
