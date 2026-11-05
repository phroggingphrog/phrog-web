# Page cache

`POST /api/fetch` and the `fetch` MCP tool reuse a recently fetched body instead of paying for it again.
Agents read a page, then re-read it to quote it; without a cache that is two provider calls, and on a
blocked host it is two failures.

## What it does

- Keyed by URL **and** the request shape (`mode`, `maxChars`), so a browser read is never served the plain
  body of the same URL.
- Default TTL **600 s**, at most **200 entries**, at most **32 MB**. Least recently used is evicted first.
- A body under 200 characters is not stored: a thin body is exactly what the next caller should retry.
- Hits return in single-digit milliseconds and carry `cached: true` plus `cache_age_s`.

```
1st  POST /api/fetch  {"url":"https://podman.io/"}   603 ms   cached:false
2nd  POST /api/fetch  {"url":"https://podman.io/"}     9 ms   cached:true  cache_age_s:0
```

## What it deliberately does not cache

| case | why |
|---|---|
| `mode: "browser"` | the point of asking is to see the current state of a client-rendered page |
| `POST /api/fetch-profile` | the response depends on the jar, so two callers can legitimately differ |
| `provider` pinned | a caller asking a specific provider is asking for that provider, not for a memory |
| `cache: false` | explicit live read |

Nothing about *who* is asking enters the key, which is why login-dependent reads never touch it.

## Inspecting it

```
GET    /api/cache   → {entries, bytes, hits, misses, expired, evictions, hit_rate, ttl_s, max_entries, live_entries}
DELETE /api/cache   → {cleared: n}          # drops entries, keeps the lifetime counters
```

The counters are process-lifetime: a restart clears the cache and the numbers together. `DELETE` clears
entries only, because erasing the history at the same time would make `hit_rate` useless as a signal about
what this box actually re-reads.

## Why not disk

The cache exists to collapse repeats inside one working session. Persisting it would need an eviction story
across restarts and a way for a stale body to be identified as stale; a 10-minute memory window is the
honest scope for "the same page" and costs nothing to throw away.
