---
description: Run a tiered, source-heavy investigation with a searchable evidence vault, durable checkpoints, and a verified research report.
args: <topic>
section: Research Workflows
topLevelCli: true
---
Run staged research for: $@

## Run identity and resume

The canonical question is the text before the automation marker `This request comes from another agent;` or the run marker `Feynman durable research run id:`. Keep the user's wording verbatim in the run query and plan. Do not treat the automation text as part of the question.

If a durable run id is present, call `feynman_research_run_status` first, read its run manifest and files under `outputs/.runs/<run-id>/`, then continue from `resumeStep`. Do not repeat completed stages. The durable run id and current scale profile are given in the request. If no run id is present, create one before evidence gathering:

```bash
feynman research run init "<canonical question>" --profile full --json
```

Use the returned id in `feynman_research_run_step`, `feynman_research_run_tier`, and `feynman_research_run_finish`. Save stage artifacts under `outputs/.runs/<run-id>/`; retain the public plan, draft, final report, and provenance paths below.

## Artifacts and approval

Use one short lowercase slug of at most five words. Every run creates:

- `outputs/.plans/<slug>.md`
- `outputs/.drafts/<slug>-draft.md`
- `outputs/.drafts/<slug>-cited.md`
- `outputs/.drafts/<slug>-verification.md`
- `outputs/<slug>.md` or `papers/<slug>.md`
- matching `<slug>.provenance.md`
- stage notes and run events in `outputs/.runs/<run-id>/`

Write the plan before gathering evidence. It contains the verbatim question, subquestions, modality, tier choice and rationale, source plan, staged work ledger, risks, verification plan, and decisions. Do not create placeholder drafts or final reports before research begins.

If the request contains `This request comes from another agent; the research plan is pre-approved`, continue without asking for confirmation. Otherwise stop after writing the plan and ask the user to approve or change it. Do not search, fetch, delegate, or draft until they approve. Once approved, always deliver a final report and provenance file, even if a capability fails. Mark incomplete checks `BLOCKED` and explain the limitation.

## Choose the route

The scale profile is the source and depth budget: `full` is the default; `premier` roughly doubles it. The tier controls which stages run:

| Tier | Route | Use |
|---|---|---|
| `light` | 1 → 2 → 10 (one draft) → 15 → 16 | A bounded question answerable from a modest source set |
| `full` | 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 14.5 → 15 → 16 | Broad, comparative, argumentative, or high-stakes research |
| `dissertation` | 1 → 1.5 → chapter loops of 2–10 → global synthesis → 12 → 13 → 14 → 14.5 → 15 → 16 | Explicitly requested long-form chaptered work; experimental |

Step 1 classifies only `light` or `full`; never select dissertation unless explicitly requested. Use the manifest's source targets, draft count, and stage list. If a topic is a narrow fact or explainer, prefer light. Do not inflate a bounded request. If the user supplied a spend ceiling, stop at it and produce a partial report. After classification, call `feynman_research_run_tier` so the manifest has the actual route.

## Stage protocol

Before each stage, call `feynman_research_run_step` with status `running`. After writing its artifact and meeting its exit condition, call it with status `done` and the checkpoint path. Mark stages intentionally omitted by the selected tier `skipped`. Keep each artifact under the run directory, with a short descriptive name. A stage is not done because a subagent launched; collect its result, inspect its file, and record failures.

### 1 — Decompose

Break the question into answerable subquestions and an explicit coverage matrix. Choose a modality: collect, synthesize, compare, or forecast. Set evidence requirements and identify decisions that must not be guessed. Select light/full and explain why in the plan. Do not silently widen a light question.

### 1.5 — Dissertation partition (dissertation tier only)

Partition the coverage matrix into coherent chapters with boundaries, inclusion rules, and source budgets. Each chapter is the unit for stages 2–10. Record cross-chapter questions for global synthesis. Do not exceed the configured chapter count without explaining why.

### 2 — Width sweep and source capture

Search several distinct angles for each subquestion. Use Feynman's scholarly databases for papers and primary literature; use `web_search` and `fetch_content` for official documentation, datasets, code, policy, and current web sources. Search reference lists and primary sources when a lead warrants it. Deduplicate candidates and prefer primary evidence. Use bounded parallel `researcher` subagents for genuinely broad questions; use direct retrieval for small bounded questions.

Read every source used as evidence. For papers without accessible full text, check OpenAlex OA locations by DOI and use Feynman's PubMed/Europe PMC `fulltext:` retrieval when a PMID or PMCID is available; fetch a returned lawful OA URL through the web MCP when appropriate. Record the OA URL, repository/provider, version, and license when known; distinguish the publisher version from accepted manuscripts and label any substituted, recovered, abstract-only, or partial text. Create a Markdown vault note for each accepted source with its title, URL/DOI, publication date, concise summary, tags, source tier, source utility and authority scores when supported, retraction status, OA metadata, fetched-at/provider provenance, and observed limitations. Record claims with direct quoted support, confidence, and evidence type. A vault note records provenance; it does not make a claim true.

### 3 — Contradiction graph (full/dissertation)

Compare claims across the captured corpus. Write `contradictions.md` with each disputed proposition, the strongest evidence on each side, whether the sources genuinely disagree, and what observation could resolve it. Exclude superficial wording differences.

### 4 — Locus analysis (full/dissertation)

Identify the few questions that carry most of the answer. Score each for importance, uncertainty, evidence conflict, and decision relevance. Allocate the depth budget to the highest-value loci; explain exclusions.

### 5 — Depth investigations (full/dissertation)

Run bounded independent `researcher` investigations for the selected loci, including a strong opposing case where there is a real dispute. Each investigation writes its position, evidence chain, caveats, and sources to a separate run artifact. Record failed investigators; if most fail, stop and reassess rather than pretending the depth pass happened.

### 6 — Cross-locus reconciliation (full/dissertation)

Compare the investigators' committed positions. Write `comparisons.md` with agreement, tension, dependencies, and unresolved questions. Do not erase disagreement through an unsupported average.

### 7 — Source tensions (full/dissertation)

Read the strongest relevant source passages, not only summaries. Extract expert disagreements, methodological caveats, and minority positions into `source-tensions.md`, with source-note links and exact quoted support.

### 8 — Corpus critic and gap finding (full/dissertation)

Ask what credible source or result would overturn the emerging conclusion. Check missing populations, methods, time periods, null results, and contrary evidence. Write `coverage-gaps.md` and targeted searches. Fetch only gaps that could change a claim or conclusion.

### 9 — Evidence digest (full/dissertation)

Write `evidence-digest.md`: the strongest claims, exact supporting quotes, note ids, source quality, agreement/conflict, and unsupported claims to avoid. Run the vault's source-quality recomputation before ranking. Retracted sources cannot anchor a conclusion; identify them explicitly if they are relevant to the history of a claim.

### 10 — Drafts

Recompute vault source quality and independence. Use quality-ranked vault search to curate the highest-quality notes for each major claim before drafting. Light tier writes one draft. Full tier writes three independent angles (for example, evidence-first, strongest countercase, and synthesis); do not let one draft silently become the only view. Dissertation tier drafts per chapter. Every factual paragraph gets a source trail.

### 11 — Synthesize (full/dissertation)

Write a synthesis plan and outline, then integrate the strongest material into `outputs/.drafts/<slug>-draft.md`. Preserve genuine disagreement, distinguish observations from inference, and do not invent statistics, citations, or source consensus. Light tier uses its single draft as the synthesis input.

### 12 — Adversarial critics (full/dissertation)

Use independent `reviewer` passes to challenge factual support, counterevidence, method quality, source dependence, scope, and overclaiming. Save findings in `critics.md`. Resolve fatal findings; record major unresolved ones in the final report.

### 13 — Targeted gap fetch (full/dissertation)

Fetch and assess sources only for critic-identified gaps that could change the result. Save accepted sources and claims to the vault, then update the evidence digest. Mark unavailable sources and unresolved gaps.

### 14 — Surgical repair (full/dissertation)

Apply small edits to the report for resolved critic findings. Preserve sections and claims that remain supported. Do not regenerate the whole report to hide unresolved criticism.

### 14.5 — Citation-to-claim verification (full/dissertation)

Run `feynman_vault_cite_check` on the report. Fix dangling citations. For each citation marked `needs-review`, inspect the saved source text and confirm that it supports the sentence, including numbers, comparisons, and causal language. Use the `verifier` subagent for the remaining citation pairs after the draft exists; do not treat the mechanical overlap check as proof of truth. Save results in `citation-check.md` and `verification.md`.

### 15 — Polish

Remove repetition, filler, stale framing, unqualified quotations, and claims that exceed the evidence. Keep limitations and material counterarguments. Re-run citation checks after substantive edits.

### 16 — Readability audit

Check whether a reader can follow the question, evidence, reasoning, disagreement, and conclusion. Apply only edits that preserve factual precision. Record any suggestions not applied and why.

## Finish gate

Before delivery:

1. Ensure every selected stage is `done` or `skipped`; mark any failed or incomplete stage honestly.
2. Run the citation check; resolve dangling citations and describe any `needs-review` items still unresolved.
3. Write a concise final report with a clear answer, evidence-backed reasoning, caveats, and open questions. Include only claims traceable to the source vault or reproducible artifacts.
4. Write the provenance sidecar with date, run id, profile and tier, source counts, accepted/rejected sources, substitutions, artifacts, and `Verification: PASS`, `PASS WITH NOTES`, or `BLOCKED` based on the checks actually completed.
5. Call `feynman_research_run_finish` with the final report and provenance paths. Use `done` only when all selected stages are complete and there are no dangling citations. Use `blocked` when a required check or capability remains incomplete; include the reason.

Never claim a source, citation, verification step, or artifact exists unless you inspected it. Never end with chat-only output. The final reply links the report and provenance and names any blocked check.
