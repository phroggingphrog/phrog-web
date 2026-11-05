# Login state: one jar per site

phrog-web can now read pages that need a login, without anyone pasting a password into it.

## Why it is built this way

crawl4ai's HTTP API **refuses** the three fields that would make this easy. Verified against the
running server:

```
POST /crawl  browser_config={"storage_state": "..."}        -> field not permitted on BrowserConfig from an untrusted request
POST /crawl  browser_config={"user_data_dir": "..."}        -> field not permitted
POST /crawl  browser_config={"use_persistent_context": true} -> field not permitted
```

They are trusted-only `config.yml` fields, so a cookie jar cannot ride through crawl4ai per
request. Cookies therefore go through **CDP** to the Chromium that actually holds the login.

## Two layers

**1. A profile that survives restarts.** jev-chrome used to run
`--user-data-dir=/tmp/jev-profile` with no volume — every restart wiped every login. It now runs
`--user-data-dir=/profile` against `~/apps/jev-chrome/profile`. Proven: a cookie written through a
page session landed in `/profile/Default/Cookies` and was still readable after
`systemctl --user restart jev-chrome`.

**2. Per-site jars.** `~/.config/phrog-web/profiles/<site>.json`, mode `0600`, holding just that
site's cookies. Per-site on purpose: no cookie bleed between sites, one site revocable without
touching another, and every jar's age and expiry is visible.

## Using it

```bash
# 1. log in once, in the browser itself (CDP on 127.0.0.1:9222)
#    the vault cannot help here: it is an autofill store that systemd services cannot read

# 2. snapshot that site's cookies into a jar
curl -s -X POST localhost:8890/api/profiles/github.com/save
# {"saved":true,"site":"github.com","cookies":12,"names":["user_session","..."]}

# 3. fetch a logged-in page
curl -s -X POST localhost:8890/api/fetch-profile \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/settings/profile"}'
# {"provider_used":"cdp-profile","cookies_seen":12,...}

# see what you have, and when it expires
curl -s localhost:8890/api/profiles | jq '.jars[] | {site, cookies, earliest_expiry, expired}'

# forget a site
curl -s -X DELETE localhost:8890/api/profiles/github.com
```

## Gotchas that cost time

- **`Storage.setCookies` does not persist.** It writes to a throwaway store and is gone after
  restart. Cookies must be set with `Network.setCookie` inside an attached page session. The CDP
  client does this correctly.
- **Chrome flushes cookies lazily.** Give it a few seconds after a login before exporting, or
  `podman stop -t 5` can kill the process before the SQLite write lands.
- **One profile, one browser.** Two Chromium processes cannot share a `user-data-dir`
  (`SingletonLock`). Attach over CDP instead of launching a second Chrome on the same directory.
- **The profile directory is owned by the container user** (uid 999 → subuid 100998) because of
  podman's `:U`. Read it from the host with `podman unshare`.

## What this is not

- Not a password manager: no credential is stored, only the cookies a real login produced.
- Not automatic: the first login is human-in-the-loop, and jars expire like cookies do.
- Not a bot-wall defeat: if a site refuses the box's IP, cookies won't save you. That is what
  TinyFish Browser Context Profiles are for.
