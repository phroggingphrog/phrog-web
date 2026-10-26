# instagram-feed (Hermes VM collector)

Reads the Instagram home timeline from the logged-in Chrome on the Hermes VM, with a continuation token. Read-only. Does not replace or touch `feed.js`, `ig_scroll.py`, `igswitch.py` or the Hermes cron.

## Files
- `timeline.js` - OpenCLI adapter (`opencli instagram timeline [--cursor C]`), one timeline request per call, prints `{payload: "<json>"}`.
- `ig_timeline.py` - wrapper: lock, busy check, account switch (via existing `igswitch.py` only if `~/.opencli/ig-current` differs), status mapping, JSON output.
- `fixtures/` - synthetic outputs (`sample-ok`, `sample-auth_required`, `sample-end`).

## Install (VM `phrog@192.168.122.114`)
    scp timeline.js phrog@192.168.122.114:~/.opencli/clis/instagram/timeline.js
    scp ig_timeline.py phrog@192.168.122.114:~/.opencli/ig_timeline.py
    ssh phrog@192.168.122.114 'chmod +x ~/.opencli/ig_timeline.py'

## Run (from the phrog-web host)
    ssh phrog@192.168.122.114 'python3 ~/.opencli/ig_timeline.py --account alice [--limit 12] [--cursor C]'

One JSON object on stdout, exit 0 for every status: `ok|end|auth_required|challenge|rate_limited|busy|unsupported|failed`. Fields: see `fixtures/sample-ok.json`.

## Behaviour notes
- `busy` is returned at once (no waiting) when `~/.cache/phrog-web/ig-browser.lock` is held or `ig_scroll.py` / `igswitch.py` is running. The lock only guards phrog-web runs against each other; the cron does not take it, so a cron run starting mid-call is not prevented.
- Instagram serves a few posts per request (2-3 observed). The wrapper keeps requesting (max 8 requests) until `--limit` posts are collected and never truncates, so `next_cursor` never skips posts; a page can hold slightly more than `--limit`.
- `sponsored` = `ad_id` or paid-partnership flag. Ads are kept. Nothing was seen live with this flag set yet.
- `suggested`: the response has no suggested marker (`inventory_source` is always `media_or_ad`). Proxy: not sponsored and author `followed == false`. `followed` comes from `user.friendship_status.following`; if absent it is `null` and `suggested` is `false`.
- `media_type`: `carousel` (type 8), `reel` (product_type `clips`), `video`, `photo`. `hashtags` and `mentions` are parsed from the full caption, without the `#`/`@`.
- First call after a Chrome start may hit "Navigation rejected"; the wrapper retries once after 3 s, then returns `failed`. It never restarts Chrome.
- Account switch restarts the shared Chrome (existing `igswitch.py` behaviour).

## Undo
    ssh phrog@192.168.122.114 'rm ~/.opencli/clis/instagram/timeline.js ~/.opencli/ig_timeline.py; rm -f ~/.cache/phrog-web/ig-browser.lock'
