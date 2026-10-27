from __future__ import annotations

import anyio
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import sitecrawl
from .service import WebAcquisitionService

mcp = FastMCP(
    "web",
    instructions=(
        "Self-hosted web toolbox. Fast retrieval tools: web_search, web_crawl "
        "(scrape; supports page actions), web_map, web_crawl_start/web_batch_start + web_crawl_status (background "
        "jobs), research_search, deep_search. research(question, mode='web') gives a short cited answer through Vane; "
        "deep_research_start/status/resume runs long staged research in Feynman. "
        "report through the same wiki tool used for web material. research_vault searches and saves reusable Feynman evidence. research modes extract and social, "
        "extract(urls, schema) uses the web agent. Results are public-web only by default. Cite deep_search blocks "
        "by id and url; pages behind bot checks are reported in skipped/blocked rather than returned as content."
    ),
)
_service = WebAcquisitionService()


# The service uses blocking urllib calls; run them in a worker thread so a slow
# crawl does not stall the stdio event loop (pings, cancellation, other calls).
@mcp.tool()
async def web_search(
    query: str,
    limit: int = 5,
    time_range: str | None = None,
    language: str | None = None,
    categories: str | None = None,
) -> dict:
    """Search the self-hosted SearXNG metasearch instance.

    time_range: day|week|month|year. language: e.g. "en". categories: e.g. "science", "it", "news".
    """
    return await anyio.to_thread.run_sync(
        lambda: _service.search(query, limit, time_range=time_range, language=language, categories=categories)
    )


@mcp.tool()
async def web_crawl(
    urls: list[str], max_chars: int = 12000, mode: str = "auto", actions: list[dict] | None = None, stealth: bool = False
) -> dict:
    """Fetch public HTTP(S) URLs and return cleaned markdown plus metadata.

    mode "auto" tries a plain fetch first (Trafilatura for HTML, MarkItDown for PDF/DOCX/PPTX/XLSX/EPUB)
    and uses the headless browser only for pages that need it; "plain" or "browser" forces one path.
    max_chars caps the markdown returned per URL (check `truncated`/`total_chars`).
    Each result carries fetcher, egress, sha256 and fetched_at for provenance.
    actions (browser only, up to 20 steps, run in order on the page): {"type":"click","selector":css},
    {"type":"type","selector":css,"text":...}, {"type":"press","key":"Enter","selector":css},
    {"type":"scroll","to":"bottom"|"top"|pixels}, {"type":"wait","ms":n}, {"type":"wait_for","selector":css}.
    Typing a login form works, but no cookies or sessions are kept between calls.
    stealth=True uses the browser's anti-detection options (simulate user, patched navigator, magic mode).
    """
    return await anyio.to_thread.run_sync(lambda: _service.crawl(urls, max_chars, mode=mode, actions=actions, stealth=stealth))


@mcp.tool()
async def web_map(url: str, limit: int = 200, search: str | None = None, include_subdomains: bool = False) -> dict:
    """List the URLs of a site (Firecrawl "map"): robots.txt/sitemap.xml first, page links as fallback.

    search keeps only URLs containing that text. Fast: no page content is read.
    """
    return await anyio.to_thread.run_sync(lambda: sitecrawl.map_site(_service, url, limit, search, include_subdomains))


@mcp.tool()
async def web_crawl_start(
    url: str,
    max_pages: int = 20,
    max_depth: int = 2,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    include_subdomains: bool = False,
    respect_robots: bool = True,
    max_chars: int = 8000,
    mode: str = "auto",
    stealth: bool = False,
) -> dict:
    """Start a background site crawl (Firecrawl "crawl"): follow links from `url`, return clean markdown per page.

    include/exclude are regexes on the URL. Returns a job_id; read it with web_crawl_status. Jobs live in
    the always-on web-agent service when it is up (they survive this session), else in this process.
    mode "browser" renders every page (single-page apps) and follows the links found after rendering.
    stealth=True uses the browser's anti-detection options.
    """
    params = dict(start=url, max_pages=max_pages, max_depth=max_depth, include=include, exclude=exclude,
                  include_subdomains=include_subdomains, respect_robots=respect_robots, max_chars=max_chars, mode=mode, stealth=stealth)
    return await anyio.to_thread.run_sync(lambda: sitecrawl.start(_service, "crawl", params))


@mcp.tool()
async def web_batch_start(urls: list[str], max_chars: int = 8000, mode: str = "auto") -> dict:
    """Start a background batch scrape of many URLs (Firecrawl "batch scrape"). Returns a job_id."""
    for u in urls:
        if not isinstance(u, str) or not u.strip():
            raise ValueError("each URL must be a non-empty string")
    params = dict(urls=urls[:500], max_chars=max_chars, mode=mode)
    return await anyio.to_thread.run_sync(lambda: sitecrawl.start(_service, "batch", params))


@mcp.tool()
async def deep_research_start(topic: str, workflow: str = "deepresearch",
                              profile: str = "full", tier: str = "pending", budget_usd: float | None = None,
                              register: str | None = None, inference_depth: str | None = None,
                              domain_notes: str | None = None) -> dict:
    """Start SLOW, staged deep research in Feynman. Returns a job_id for status polling.

    workflow: deepresearch (thorough cited brief) | lit (literature review) | compare (source comparison) |
    review (critique) | audit (paper vs code) | summarize (a URL/PDF) | recipe | draft. topic: one self-contained
    subject. Poll with deep_research_status.
    profile selects source scale; tier selects light/full/dissertation stages. register, inference_depth, and
    domain_notes steer the report's voice, reasoning depth, and sourcing norms. Use research(mode="web") for a
    quick answer through Vane; this tool runs long research in Feynman.
    """
    from . import deepresearch

    if workflow not in deepresearch.WORKFLOWS:
        raise ValueError(f"workflow must be one of {', '.join(deepresearch.WORKFLOWS)}")
    if not topic.strip() or len(topic) > 4000:
        raise ValueError("topic must be 1-4000 characters")
    if profile not in {"full", "premier"}:
        raise ValueError("profile must be full or premier")
    if tier not in {"pending", "light", "full", "dissertation"}:
        raise ValueError("tier must be pending, light, full, or dissertation")
    if budget_usd is not None and budget_usd <= 0:
        raise ValueError("budget_usd must be greater than zero")
    if register is not None and register not in {"teach", "survey", "analyze", "advocate"}:
        raise ValueError("register must be teach, survey, analyze, or advocate")
    if inference_depth is not None and inference_depth not in {"surface", "standard", "deep"}:
        raise ValueError("inference_depth must be surface, standard, or deep")
    if domain_notes is not None and len(domain_notes) > 2000:
        raise ValueError("domain_notes must be at most 2000 characters")
    params = dict(topic=topic.strip(), workflow=workflow, profile=profile, tier=tier,
                  budget_usd=budget_usd, register=register, inference_depth=inference_depth, domain_notes=domain_notes)
    out = await anyio.to_thread.run_sync(lambda: sitecrawl.start(_service, "deep", params))
    if "web-agent service" not in out.get("runs_in", ""):
        out["warning"] = "web-agent service unreachable: this MCP process owns the job and it may need reattachment if the process exits"
    return out


@mcp.tool()
async def deep_research_resume(run_id: str) -> dict:
    """Resume an interrupted Feynman run from its durable checkpoint and first unfinished stage."""
    if not run_id.strip() or len(run_id) > 120:
        raise ValueError("run_id must be 1-120 characters")
    from . import feynman

    manifest = await feynman.call("feynman_research_status", {"runId": run_id.strip()})
    topic = manifest.get("query", "") if isinstance(manifest, dict) else ""
    if not topic:
        raise ValueError(f"Feynman run '{run_id}' did not return its original query")
    params = dict(topic=topic, workflow="deepresearch", resume_run_id=run_id.strip())
    out = await anyio.to_thread.run_sync(lambda: sitecrawl.start(_service, "deep", params))
    if "web-agent service" not in out.get("runs_in", ""):
        out["warning"] = "web-agent service unreachable: this MCP process owns the job and it may need reattachment if the process exits"
    return out


@mcp.tool()
async def research_vault(
    action: str,
    query: str = "",
    note_id: str = "",
    title: str = "",
    body: str = "",
    source: str = "",
    tier: str = "",
    content_type: str = "",
    summary: str = "",
    doi: str = "",
    venue: str = "",
    citation_count: int | None = None,
    utility_score: float | None = None,
    authority_score: float | None = None,
    source_domain: str = "",
    fetched_at: str = "",
    fetch_provider: str = "",
    is_retracted: bool | None = None,
    oa_url: str = "",
    oa_source: str = "",
    oa_version: str = "",
    oa_license: str = "",
    oa_recovery_kind: str = "",
    claim: str = "",
    quoted_support: str = "",
    confidence: str = "",
    evidence_type: str = "",
    stance_target: str = "",
    stance: str = "",
    run_id: str = "",
    tags: list[str] | None = None,
    limit: int = 10,
    ranked: bool = False,
) -> dict:
    """Read or save reusable evidence in Feynman's Markdown source vault.

    action: status | search | read | save | add_claim | search_claims. Search by query; read by note_id; save
    requires title and body; provide DOI, scholarly quality, retraction, and open-access metadata when known.
    add_claim requires note_id and claim; search_claims requires query. SQLite is a rebuildable index, not canonical storage.
    """
    from . import feynman

    if action not in {"status", "search", "read", "save", "add_claim", "search_claims"}:
        raise ValueError("action must be status, search, read, save, add_claim, or search_claims")
    if action == "status":
        return await feynman.call("feynman_vault_status", {})
    if action == "search":
        if not query.strip():
            raise ValueError("query is required for action=search")
        return await feynman.call("feynman_vault_search", {"query": query, "limit": max(1, min(100, limit)), "tags": tags or [], "ranked": ranked})
    if action == "search_claims":
        if not query.strip():
            raise ValueError("query is required for action=search_claims")
        arguments: dict[str, Any] = {"query": query, "limit": max(1, min(100, limit))}
        if run_id.strip():
            arguments["runId"] = run_id.strip()
        return await feynman.call("feynman_vault_claim_search", arguments)
    if action == "read":
        if not note_id.strip():
            raise ValueError("note_id is required for action=read")
        return await feynman.call("feynman_vault_read", {"id": note_id.strip()})
    if action == "add_claim":
        if not note_id.strip() or not claim.strip():
            raise ValueError("note_id and claim are required for action=add_claim")
        arguments = {"noteId": note_id.strip(), "claim": claim.strip()}
        if quoted_support.strip():
            arguments["quotedSupport"] = quoted_support
        if confidence.strip():
            arguments["confidence"] = confidence
        if evidence_type.strip():
            arguments["evidenceType"] = evidence_type
        if stance_target.strip():
            arguments["stanceTarget"] = stance_target
        if stance.strip():
            arguments["stance"] = stance
        if run_id.strip():
            arguments["runId"] = run_id.strip()
        return await feynman.call("feynman_vault_add_claim", arguments)
    if not title.strip() or not body.strip():
        raise ValueError("title and body are required for action=save")
    arguments: dict[str, Any] = {"title": title, "body": body, "tags": tags or []}
    if source.strip():
        arguments["source"] = source.strip()
    for key, value in {
        "tier": tier, "contentType": content_type, "summary": summary, "doi": doi, "venue": venue,
        "citationCount": citation_count, "utilityScore": utility_score, "authorityScore": authority_score,
        "sourceDomain": source_domain, "fetchedAt": fetched_at, "fetchProvider": fetch_provider,
        "isRetracted": is_retracted, "oaUrl": oa_url, "oaSource": oa_source, "oaVersion": oa_version,
        "oaLicense": oa_license, "oaRecoveryKind": oa_recovery_kind,
    }.items():
        if value is not None and value != "":
            arguments[key] = value
    return await feynman.call("feynman_vault_create_note", arguments)


@mcp.tool()
async def deep_research_status(job_id: str, include_result: bool = False) -> dict:
    """Progress of a deep research job. When status is completed, include_result=True returns the cited markdown."""
    return await anyio.to_thread.run_sync(lambda: sitecrawl.job_status(job_id, include_result, 0, 0))


@mcp.tool()
async def browse(url: str, goal: str, max_seconds: int = 90) -> dict:
    """Drive a real browser toward a goal (Jev): clicks, typing, selecting, scrolling, until done or blocked.

    Use for multi-step sites where you can't name selectors ("search this site for X and open the top result", fill a
    search form). Returns status (done|blocked), the steps taken and the final page url/title/visible text. For plain
    reading use web_crawl. Runs in a separate throwaway headless Chromium (no logins, no saved sessions). Each step sends the
    page's visible text and controls to the configured Jev decision endpoint. Needs TYPESAFE_API_KEY in the env file.
    """
    from . import browse as browse_mod

    return await anyio.to_thread.run_sync(lambda: browse_mod.browse(url, goal, max_seconds))


@mcp.tool()
async def web_crawl_status(job_id: str, include_results: bool = False, offset: int = 0, limit: int = 10) -> dict:
    """Progress of a crawl or batch job; include_results=True returns pages[offset:offset+limit]."""
    return await anyio.to_thread.run_sync(lambda: sitecrawl.job_status(job_id, include_results, offset, limit))


@mcp.tool()
async def research_search(
    query: str,
    preset: str = "academic",
    sources: list[str] | None = None,
    limit: int = 3,
    stackexchange_site: str = "stackoverflow",
) -> dict:
    """Search free research APIs in parallel (no keys, no bot checks) and return structured results.

    preset: academic (openalex, arxiv, semantic_scholar, crossref, wikipedia) | tech (stackexchange,
    hackernews, wikipedia) | all. `sources` overrides the preset. limit is per source (max 10).
    stackexchange_site: stackoverflow, stats (Cross Validated), math, datascience, dba, ...
    Results include authors, year, citations, DOI and open-access pdf_url where the API provides them;
    pass a pdf_url to web_crawl to read the paper. Per-source failures are listed in `errors`.
    """
    return await anyio.to_thread.run_sync(
        lambda: _service.research(query, sources, preset, limit, stackexchange_site)
    )


@mcp.tool()
async def deep_search(
    query: str,
    num_sources: int = 3,
    time_range: str | None = None,
    language: str | None = None,
) -> dict:
    """Search, crawl the best sources, and return numbered, cited context blocks for downstream synthesis.

    Failed, bot-checked, or near-empty pages are replaced from further search results and listed in `skipped`.
    """
    return await anyio.to_thread.run_sync(
        lambda: _service.deep_search(query, num_sources, time_range=time_range, language=language)
    )



# ---- web research agent tools (LLM-backed), registered on this same server -------------------
from .web_agent_server import extract, research  # noqa: E402

for _tool in (research, extract):
    mcp.tool()(_tool)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
