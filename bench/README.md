# Search ranking benchmark

Measures the **ranker**, not the engines. Candidate rows are captured once into
`fixtures/<corpus>/`, then two rankers replay the *same* rows, so any delta is
attributable to ranking and nothing else.

```
npm run bench:corpus           # rebuild the corpus from real usage (runs.jsonl)
npm run bench:capture          # snapshot candidates for the seed corpus
npm run bench:capture:history  # snapshot candidates for the history corpus
npm run bench                  # score both, with per-corpus tables
```

## Corpora

| File | Source | Judgments |
|---|---|---|
| `queries.json` | 20 hand-written infra/doc queries | author-supplied expected domains |
| `queries.history.json` | generated from `~/.local/state/phrog-web/runs.jsonl` | the host of the page you actually fetched within 10 min of searching |

`queries.history.json` is the honest one. A "domain" is the host of the page that
was opened after a search — implicit relevance from your own behaviour, not my
guess at which site *ought* to answer.

## Metrics

- **P@8** — hits / 8
- **R@8** — distinct expected domains covered / expected (each counted once; nested
  domains like `podman.io` and `docs.podman.io` both matching one row used to make
  recall exceed 1)
- **MRR@8** — 1 / rank of the first expected result, 0 if absent

Significance is a paired bootstrap over queries (5000 resamples, 95% CI). A CI
straddling 0 means the corpus cannot tell the two rankers apart.

The eval also reports how many queries had their expected page in **no** top-8
list at all — those are engine-recall failures, and no ranker can fix them.
