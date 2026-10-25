---
title: Research Vault
description: Save and search reusable source notes and claims across Feynman research runs.
section: Tools
order: 4
---

Feynman's research vault keeps accepted source material as Markdown in the active project. SQLite is a rebuildable index for full-text search, tags, aliases, source metadata, claims, and note links. Feynman does not automatically import your existing papers or outputs.

## CLI

```bash
feynman vault init
feynman vault status --json
feynman vault search "causal inference" --limit 10 --json
feynman vault read <note-id> --json
feynman vault sync
feynman vault export ../research-vault-backup
feynman vault import ../another-markdown-vault
```

Create a source note with its provenance:

```bash
feynman vault note create \
  --title "Source title" \
  --source "https://example.org/source" \
  --tags methods,evidence \
  --body "Evidence summary and limitations."
```

`feynman vault sync` rebuilds the index from Markdown. Notes remain the canonical data; you can read and edit them with any Markdown editor.

Import and export operate on Markdown directories. Import is explicit and refuses to overwrite existing note ids or paths. Export requires a new destination directory and copies notes only; the SQLite index is rebuilt with `sync`.

## In a research session

Feynman provides tools to search and read notes, save source-backed evidence, add and search claims, inspect backlinks, recompute source quality and independence, and check citation bindings. A stored source is not automatically verified truth. Keep the URL, quoted support, and limitations with each claim.

## MCP

Run `feynman mcp` in a research workspace to expose its research runs and vault operations at `http://127.0.0.1:8910/mcp`. The default listener is loopback and has no bearer authentication; put a trusted proxy in front of it before making it reachable from another host.
