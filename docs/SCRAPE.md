# Scrape formats

`POST /api/scrape` returns up to six representations of one page, in one call.

```bash
curl -s -X POST localhost:8890/api/scrape -H 'Content-Type: application/json' -d '{
  "url": "https://podman.io/",
  "formats": ["markdown","html","rawHtml","links","screenshot"],
  "fullPage": false,
  "screenshotInline": false
}'
```

| format | what you get | where it comes from |
|---|---|---|
| `markdown` | main content as Markdown | plain HTML → cleaner; escalates to crawl4ai/jina/tinyfish when thin |
| `html` | cleaned HTML (scripts/styles/comments stripped) | the same fetched document |
| `rawHtml` | the document exactly as served | the same fetched document |
| `links` | `[{text, href}]`, absolute, deduped, fragment-stripped, max 500 | parsed from the document |
| `screenshot` | PNG file + `/shots/<name>` URL + width/height | rendered in the existing Chromium over CDP |
| `json` | `{data, valid, errors}` from your JSON Schema | the extractor |

## Two design rules

**One page visit, not six.** The HTML is fetched once and every text format is derived from it. A
screenshot is the only format that costs a second visit, because it needs the renderer. An earlier
version routed the whole scrape through the browser whenever `screenshot` was requested — that
tripled latency for markdown. Fixed: `mode: "browser"` is now the only thing that forces rendering
for text formats.

**No invented schemas.** Ask for `json` without a `jsonSchema` and you get

```json
{"skipped":[{"format":"json","reason":"no jsonSchema supplied; refusing to invent a shape"}]}
```

rather than a guess that looks like data.

## Verified

`podman.io` with `["markdown","html","links","screenshot"]`:

```
provider_used: plain   markdown: 2688 chars   html: 29581 chars   links: 32
screenshot: 176502 bytes, 765 x 437, served at /shots/7a1d2eba588a3a472d94.png (magic 89504e47 = PNG)
fullPage:   765 x 4844, 196100 bytes
json:       {"title":"Podman Installation | Podman","install_command":"sudo pacman -S podman"}  valid: true
```

## Screenshots

Written to `~/.local/state/phrog-web/shots/<20-hex>.png` and served from `GET /shots/<name>`, which
only accepts `^[a-f0-9]{8,40}\.png$` so the route cannot be used to read arbitrary files. Use
`screenshotInline: true` to get base64 in the response instead of a URL.
