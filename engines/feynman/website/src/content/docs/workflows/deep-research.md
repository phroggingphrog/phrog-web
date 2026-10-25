---
title: Deep Research
description: Run a thorough, multi-agent investigation that produces a cited research brief.
section: Workflows
order: 1
---

Deep research runs a staged, tiered investigation and produces a cited report with provenance. It reuses source notes in a Markdown vault and saves run manifests and checkpoints so an interrupted run can resume. Each run can record its source scale, light/full/dissertation tier, report register, inference depth, domain sourcing notes, and budget.

## Usage

From the REPL:

```
/deepresearch What are the current approaches to mechanistic interpretability in LLMs?
```

From the CLI:

```bash
feynman deepresearch "What are the current approaches to mechanistic interpretability in LLMs?"
```

For an interactive run, `/deepresearch` writes a plan and waits for you to reply "yes" or request changes. Nothing is searched, fetched, or drafted before you approve. An agent calling through the Feynman MCP supplies an approved plan and runs unattended.

## How it works

1. **Plan and classify** -- Feynman records the query, subquestions, modality, tier, source budget, stages, and checks in the run manifest and plan. `light` runs a bounded route; `full` includes contradiction mapping, depth investigations, counterevidence, multiple draft angles, and adversarial critics. `dissertation` is experimental and only selected when requested.
2. **Gather and store** -- Search academic databases and the web, inspect accepted sources, save Markdown source notes and claims to `research/vault/`, and record source limitations. Feynman reuses its existing literature tools and web MCP acquisition tools.
3. **Analyze** -- Full runs map contradictions, score key questions, investigate them independently, reconcile positions, identify source tensions, challenge the corpus, and write an evidence digest.
4. **Draft and challenge** -- Light runs create one draft; full runs create three independent draft angles, synthesize the strongest evidence, and run adversarial critique.
5. **Verify and deliver** -- Targeted gap searches, surgical revision, citation-to-claim checks, polishing, and readability review precede the final report. A manifest records each stage and checkpoint; incomplete checks are reported as blocked.

If a tool or source fails after approval, the run continues in degraded mode and still writes a final output marked `Verification: BLOCKED` or `PASS WITH NOTES`.

## Output

| File | Contents |
| --- | --- |
| `outputs/.plans/<slug>.md` | Plan, task ledger, verification log |
| `outputs/.drafts/<slug>-draft.md` | Uncited draft |
| `outputs/.drafts/<slug>-cited.md` | Draft with inline citations and Sources |
| `outputs/.drafts/<slug>-revised.md` | Written only when review fixes need a full rewrite |
| `outputs/<slug>.md` (or `papers/<slug>.md` for paper-style drafts) | Final brief |
| `<slug>.provenance.md` next to the final brief | Date, sources consulted/accepted/rejected, verification status, research files |

Per-stage files and the durable run manifest are stored under `outputs/.runs/<run-id>/`. Resume a stopped run with `feynman research run resume <run-id>` or through `feynman_resume` on MCP.

The brief contains an executive summary, findings organized by question or theme, evidence-backed caveats and disagreements, open questions, and a Sources section.

The source vault is project-local. See [Research Vault](/docs/tools/research-vault) for indexing, note, and MCP commands.

## Customization

Steer the run in your prompt. Narrow topics produce focused briefs; broad topics produce survey-style overviews. Constraints such as "focus on papers from 2025" or "only consider empirical results" narrow the search. Ask for comprehensive coverage if you want researcher agents on a topic that would otherwise be treated as a simple explainer.
