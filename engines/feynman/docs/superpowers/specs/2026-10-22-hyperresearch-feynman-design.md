# Hyperresearch port into Feynman

## Intent

The owner asked to fork Hyperresearch and integrate it with the self-hosted web MCP, then clarified: “what I mean is we fully port it into Feynman” and “like the code itself.” The goal is to bring Hyperresearch’s working research and knowledge-base system into Feynman as a native capability, then expose that capability through the existing web MCP. This is a code and feature port, not just borrowing prompt ideas or running Hyperresearch as a Python sidecar.

Feynman remains the research product and owner of long-running research. The self-hosted web MCP remains the caller-facing web tools service. Vane remains its short-answer search backend unless the owner later approves a separate live cutover.

## Why

Feynman already has a deep-research workflow, research subagents, scholarly and web tools, citation verification, provenance artifacts, and MCP use in production. Hyperresearch adds a more systematic multi-stage research process and a persistent searchable source vault. Porting those capabilities into Feynman gives its research runs reusable evidence and stronger coverage and audit steps without creating a second research runtime.

## Goals

- Port Hyperresearch’s actual research and vault capabilities into Feynman’s TypeScript, Node, and Pi architecture. Do not install its Python package as a runtime dependency or shell out to a separate Hyperresearch process.
- Upgrade Feynman’s existing `/deepresearch` workflow with the tiered pipeline: query decomposition, broad search, contradiction analysis, depth selection and investigation, reconciliation, source tensions, pre-draft gap finding, evidence digest, parallel drafts, synthesis, adversarial critics, targeted gap fetch, surgical repair, citation checks, polish, and readability review.
- Port the corresponding run controls: light/full tiers, scale profiles, report registers and depth levers, per-run manifests, progress, checkpoints, and resume.
- Add a Feynman-owned source vault. Markdown is canonical; SQLite is rebuildable and supports full-text search, tags, aliases, wiki links, provenance, note lifecycle, scholarly metadata, source-quality data, and claims. Preserve Hyperresearch’s useful vault operations through native Feynman commands and agent tools.
- Reuse Feynman’s existing scholarly integrations and the self-hosted web MCP’s SearXNG/Crawl4AI acquisition path where they cover the same need. Port missing research and vault behavior instead of adding Hyperresearch’s independent crawler stack.
- Move durable job identity and resume state into Feynman. The current MCP bridge’s in-memory job IDs and 1,700-second process cap are not the long-run state owner.
- Have the self-hosted web MCP call Feynman’s native start/status/result interface. Keep its existing fast `deep_search` behavior for bounded search-and-fetch context.
- Consolidate the caller-facing web tools under the existing `web` MCP. Route its short, synthesized web answer through Vane, and its long research through Feynman. Keep backend services separate.

## Proposed feature scope

### Port into Feynman

1. **Research orchestration:** The full Hyperresearch staged pipeline, bounded/light route, profiles and levers, per-run artifacts, checkpointing, resumability, and completion gate. Integrate this into Feynman’s existing deep-research workflow rather than shipping a second top-level research product.
2. **Vault engine:** Markdown notes and frontmatter; SQLite schema and migrations; indexing and synchronization; full-text search and filters; graph links and backlinks; note lifecycle and lint; source provenance; scholarly enrichment and retraction metadata; claim storage/search; duplicate detection; exports/imports; and optional embeddings.
3. **Research acquisition and quality:** Port source-ranking, independence analysis, open-access recovery, citation-to-sentence checking, and the pipeline’s gap/critic/patch logic. Connect these to Feynman’s existing research agents and tools. Keep source substitutions and verification limitations visible in stored notes and reports.
4. **Native surfaces:** Re-express Hyperresearch CLI and MCP operations as Feynman CLI commands, Pi tools/workflows, and a native Feynman MCP API where needed. Do not bring over Claude Code or Codex marketplace installers, since Feynman is the host runtime.
5. **Web MCP integration:** Keep the existing raw search, crawl, map, extraction, scholarly lookup, and `deep_search` tools. Route its short web-research mode through Vane and its long research start/status/result calls through Feynman.

Hyperresearch’s CLI and Python module boundaries are reference structure, not a requirement to keep the same language or duplicate every provider implementation. The port should preserve user-visible research and vault behavior using Feynman’s native components.

## Vane and MCP boundary

The live Vane MCP currently answers `tools/list` with `web_research` and `web_status`; the Vane service is active. `web_status` is a compatibility placeholder that always errors because Vane has no asynchronous jobs. The existing web MCP already has raw retrieval and Feynman deep-research tools.

Use **one caller-facing MCP surface, not one combined backend process**. The existing `web` MCP is the facade because it already owns acquisition tools and Feynman’s deep-run bridge. Vane remains a separate backend for concise cited answers. Feynman owns long-run research and the source vault. Keep only one caller-facing short-answer operation; route the current web `research` web mode to Vane rather than exposing duplicate Vane and Deep Agent answer tools. Preserve the existing `extract` and `social` research modes if they still have distinct behavior. Do not carry Vane’s fake `web_status` forward; use Feynman’s real job status.

Do not change or disable the currently live Vane MCP or portal during this port. Keep its current endpoint available until a separately reviewed cutover, consistent with Vane’s existing intent.

## Non-goals

- Do not replace Feynman, Vane, SearXNG, Crawl4AI, or the existing self-hosted web MCP.
- Do not add a second Python research service, crawler, or persistent database service.
- Do not change the live Vane portal or disable its MCP endpoint as part of the code port.
- Do not write directly into accepted wiki pages. Curated material continues through the existing wiki inbox approval flow.
- Do not change unrelated Feynman workflows or broaden Feynman into general-purpose productivity.
- Do not claim that structural or citation checks guarantee factual truth.

## Constraints

- Feynman is MIT-licensed TypeScript/Node, targets Node 22+, and uses Pi prompts, extensions, and subagents. Preserve upstream Hyperresearch MIT attribution and license notices in the forked port.
- Hyperresearch is a sizeable Python application, not a small library. A native TypeScript port is substantial and must be staged by capability while keeping the final parity target explicit.
- Feynman has a small package-release size budget. Evaluate SQLite/FTS implementation and database drivers against that budget before adding dependencies.
- The web MCP and Vane are separate deployed services with existing callers. Maintain current tool contracts during development; portal cutover is separately reviewed.
- Research stays self-hosted under the existing model and egress policies. Credentials remain in environment/config files and never enter source or reports.
- Keep all changes in the isolated Feynman worktree `/home/phroggingphrog/projects/.worktrees/feynman-hyperresearch-port` on `codex/hyperresearch-feynman-port`.

## Builder-owned details

- Choose a compact internal module layout for vault, run engine, and source ranking that fits Feynman’s extension and CLI architecture.
- Choose the SQLite package/FTS implementation and migration approach, subject to the release budget.
- Map Hyperresearch’s agents to Feynman’s existing `researcher`, `writer`, `verifier`, and `reviewer` roster; add agents only where a distinct role is required.
- Decide which optional Hyperresearch features (semantic embeddings, local vault web UI, dissertation tier) can fit the first release without undermining native parity. If deferred, document the exact deferred behavior rather than implying full parity.
- Preserve current `outputs/` artifacts and provenance. Design migration/import as explicit and non-destructive; do not silently ingest existing project outputs.
- Preserve the current Feynman MCP request/result shape where possible while adding durable job state, progress, resume, and failure reporting.

## Acceptance picture

- Feynman can run the Hyperresearch-style staged deep-research workflow using its native tools and agents, save all run artifacts and provenance, and resume a failed run from a durable checkpoint.
- The Feynman source vault stores Markdown notes as canonical content, rebuilds its SQLite index from those notes, and supports note search and source/provenance navigation from Feynman’s native surfaces.
- Feynman’s deep-research results pass source-to-claim citation checks and distinguish primary source text from substituted or recovered text.
- The existing `web` MCP remains the single caller-facing web tool surface for fast acquisition, Vane-backed short answers, and Feynman-backed long research. `deep_search` retains its existing bounded cited-context contract.
- Vane remains available and unchanged until a separate portal/MCP cutover review.

## Port parity inventory

| Hyperresearch surface | Feynman-native port | Boundary |
|---|---|---|
| 16-stage research pipeline, light/full/dissertation tiers, profiles and levers | `/deepresearch` prompt, `research run` manifest/checkpoint commands, Pi run tools, and Feynman MCP start/status/result/resume | Uses Feynman's researcher, writer, verifier, and reviewer agents instead of installing upstream Claude/Codex subagents or hooks. |
| Markdown vault, frontmatter, SQLite FTS, tags, aliases, links, note lifecycle and claims | `src/vault`, `feynman vault`, Pi vault tools, and Feynman MCP note/search/claim tools | Markdown is canonical; SQLite is rebuildable. Markdown directory import/export is explicit and refuses to overwrite. |
| Source quality, PageRank centrality and derivative-source independence | Feynman quality recomputation and quality-ranked FTS search | Duplicate clusters are reported for review; notes are not automatically merged. |
| OpenAlex/Crossref/PubMed/Europe PMC/arXiv discovery, OA metadata and full text | Existing Feynman scholarly tools plus web MCP fetch; accepted notes preserve DOI, venue, citations, retraction, OA URL/provider/version/license and recovery kind | No second scholarly client or crawler is installed. OA replacement must be labeled in notes and reports. |
| Citation-to-source checks and adversarial report review | SQLite claim/source citation checker plus the staged verifier/reviewer passes and finish gate | Mechanical matches are triage, not truth certification; unresolved pairs remain `needs-review` or blocked. |
| Hyperresearch web acquisition and Vane-style answer modes | Existing Web MCP retrieval; Vane backs concise `research(mode="web")`; Feynman backs long staged research and vault operations | One caller-facing `web` MCP; Vane's separate live MCP/portal stays untouched. |

Deferred upstream-adjacent features are intentionally bounded: semantic embeddings were dormant in Hyperresearch's roadmap and remain absent; no automatic note merge is provided; Markdown transfer does not import Hyperresearch's SQLite database or export its upstream JSON bundles; and there is no separate numeric/quote lint CLI beyond the citation checker and model review stages. These choices avoid a second vector service, destructive deduplication, and duplicate implementations where Feynman already has native tools.
