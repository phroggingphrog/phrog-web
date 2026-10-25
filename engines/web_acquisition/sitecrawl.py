"""Firecrawl-style site tools on top of the self-hosted fetchers: map, site crawl and batch jobs.

No LLM here. Pages come from the plain fetcher (links are read from the raw HTML); pages that
convert to almost nothing are re-read through the browser crawler for their text. Jobs run in
a background thread of the calling process and persist their state under ~/.local/state.
"""

from __future__ import annotations

import json
import os
import urllib.request
import re
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

from lxml import html as lxml_html

from . import fetch
from .service import WebAcquisitionService, _validate_public_url

STATE_DIR = Path(os.getenv("WEB_MCP_STATE_DIR", "~/.local/state/web-acquisition")).expanduser() / "jobs"
SHORT = 300  # converted text under this many chars: ask the browser crawler for the text
UA = "self-hosted-web-mcp"
_lock = threading.Lock()


def _get(service: WebAcquisitionService, url: str, timeout: float = 20.0) -> tuple[str, int, str, bytes]:
    errors = []
    for egress, proxy in service._plain_routes():
        try:
            return fetch.plain_get(url, timeout, service.settings.allow_private_urls, proxy)
        except fetch.FetchError as exc:
            errors.append(f"{egress}: {exc}")
    raise fetch.FetchError("; ".join(errors))


def _links(base: str, body: bytes) -> list[str]:
    try:
        doc = lxml_html.fromstring(body)
    except (ValueError, lxml_html.etree.ParserError):
        return []
    out = []
    for href in doc.xpath("//a/@href"):
        absolute = urldefrag(urljoin(base, href.strip()))[0]
        if urlparse(absolute).scheme in {"http", "https"}:
            out.append(absolute)
    return out


def _same_site(url: str, root: str, subdomains: bool) -> bool:
    a, b = urlparse(url).hostname or "", urlparse(root).hostname or ""
    return a == b or (subdomains and a.endswith("." + b))


def _sitemap_urls(service: WebAcquisitionService, sitemap: str, limit: int, depth: int = 0) -> list[str]:
    try:
        _, status, _, body = _get(service, sitemap)
        if status != 200:
            return []
        root = ET.fromstring(body)
    except (fetch.FetchError, ET.ParseError):
        return []
    locs = [e.text.strip() for e in root.iter() if e.tag.endswith("}loc") or e.tag == "loc" if e.text]
    if root.tag.endswith("sitemapindex") and depth < 2:
        found: list[str] = []
        for child in locs[:5]:
            found += _sitemap_urls(service, child, limit - len(found), depth + 1)
            if len(found) >= limit:
                break
        return found
    return locs[:limit]


def _robots(service: WebAcquisitionService, url: str) -> tuple[RobotFileParser, list[str]]:
    p = urlparse(url)
    robots_url = f"{p.scheme}://{p.netloc}/robots.txt"
    parser, sitemaps = RobotFileParser(), []
    try:
        _, status, _, body = _get(service, robots_url, 10.0)
        text = body.decode("utf-8", "replace") if status == 200 else ""
    except fetch.FetchError:
        text = ""
    parser.parse(text.splitlines())
    sitemaps = re.findall(r"(?im)^sitemap:\s*(\S+)", text)
    return parser, sitemaps


def map_site(service: WebAcquisitionService, url: str, limit: int = 200, search: str | None = None,
             include_subdomains: bool = False) -> dict[str, Any]:
    url = _validate_public_url(url, service.settings.allow_private_urls)
    limit = max(1, min(int(limit), 5000))
    _, sitemaps = _robots(service, url)
    p = urlparse(url)
    candidates = sitemaps or [f"{p.scheme}://{p.netloc}/sitemap.xml"]
    urls: list[str] = []
    source = "sitemap"
    for sm in candidates[:3]:
        urls += _sitemap_urls(service, sm, limit)
    if not urls:
        source = "links"
        try:
            final, _, _, body = _get(service, url)
            urls = [final] + _links(final, body)
        except fetch.FetchError as exc:
            return {"url": url, "source": "none", "count": 0, "urls": [], "error": str(exc)}
    seen, out = set(), []
    for u in urls:
        if u in seen or not _same_site(u, url, include_subdomains):
            continue
        if search and search.lower() not in u.lower():
            continue
        seen.add(u)
        out.append(u)
        if len(out) >= limit:
            break
    return {"url": url, "source": source, "count": len(out), "urls": out}


def crawl_site(service: WebAcquisitionService, start: str, max_pages: int = 20, max_depth: int = 2,
               include: list[str] | None = None, exclude: list[str] | None = None,
               include_subdomains: bool = False, respect_robots: bool = True, max_chars: int = 8000,
               budget_s: float = 300.0, mode: str = "auto", stealth: bool = False, progress: Any = None) -> dict[str, Any]:
    start = _validate_public_url(start, service.settings.allow_private_urls)
    max_pages, max_depth = max(1, min(int(max_pages), 200)), max(0, min(int(max_depth), 6))
    inc = [re.compile(x) for x in include or []]
    exc = [re.compile(x) for x in exclude or []]
    robots, _ = _robots(service, start) if respect_robots else (None, [])
    deadline = time.monotonic() + budget_s
    queue, seen, pages, skipped = deque([(start, 0)]), {start}, [], []
    while queue and len(pages) < max_pages and time.monotonic() < deadline:
        url, depth = queue.popleft()
        if robots is not None and not robots.can_fetch(UA, url):
            skipped.append({"url": url, "reason": "robots.txt"})
            continue
        links, browser_links = [], None
        try:
            if mode == "browser":
                raise fetch.FetchError("render requested")
            final, status, ctype, body = _get(service, url)
            text, title, converter = fetch.convert(final, ctype, body)
            links = _links(final, body) if "html" in ctype.lower() else []
        except fetch.FetchError as err:
            final, status, ctype, text, title, converter = url, 0, "text/html", "", "", "none"
            if mode != "browser":
                pages.append({"url": url, "depth": depth, "success": False, "error": str(err)})
                continue
        fetcher = f"plain:{converter}"
        if mode == "browser" or len(text) < SHORT:
            try:
                r = service.crawl([url], max_chars, mode="browser", stealth=stealth)["results"][0]
                if r.get("success") and len(r.get("markdown") or "") > len(text):
                    text, fetcher, title = r["markdown"], "browser", r.get("title") or title
                    status = r.get("status_code") or status or 200
                    browser_links = r.get("links")  # rendered page: these include JavaScript-built links
            except Exception:  # browser crawler unavailable: keep the short plain text
                pass
            if mode == "browser" and fetcher != "browser":
                pages.append({"url": url, "depth": depth, "success": False, "error": "browser crawl failed"})
                continue
        if browser_links is not None:
            links = [urldefrag(urljoin(final, h))[0] for h in browser_links]
        pages.append({"url": final, "depth": depth, "success": status < 400, "status_code": status,
                      "title": title, "fetcher": fetcher, "markdown": text[:max_chars],
                      "truncated": len(text) > max_chars})
        if progress:
            progress(len(pages), len(pages) + len(queue))
        if depth < max_depth:
            for link in links:
                if link in seen or not _same_site(link, start, include_subdomains):
                    continue
                if (inc and not any(r.search(link) for r in inc)) or any(r.search(link) for r in exc):
                    continue
                seen.add(link)
                queue.append((link, depth + 1))
        time.sleep(0.2)
    return {"start": start, "count": len(pages), "pages": pages, "skipped": skipped,
            "stopped": "max_pages" if len(pages) >= max_pages else ("budget" if queue else "done")}


# ---- jobs -----------------------------------------------------------------------------------

def _path(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f-]{36}", job_id):
        raise ValueError("invalid job id")
    return STATE_DIR / f"{job_id}.json"


def _write(job: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        tmp = _path(job["id"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(job))
        tmp.replace(_path(job["id"]))


_deep_gate = threading.Lock()  # Feynman runs one job at a time: ours wait here (status "queued") instead of failing "busy"


def _deep_key(params: dict[str, Any]) -> str:
    import hashlib

    if params.get("resume_run_id"):
        return hashlib.sha1(f"resume|{params['resume_run_id']}".encode()).hexdigest()
    identity = (
        params.get("workflow"), params.get("profile", "full"), params.get("tier", "pending"),
        params.get("budget_usd"), params.get("register"), params.get("inference_depth"), params.get("domain_notes"),
        bool(params.get("to_wiki")), params.get("title", ""),
        " ".join(str(params.get("topic", "")).lower().split()),
    )
    return hashlib.sha1(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()


def _active_deep(key: str) -> dict[str, Any] | None:
    for f in STATE_DIR.glob("*.json") if STATE_DIR.exists() else []:
        try:
            j = json.loads(f.read_text())
        except ValueError:
            continue
        if j.get("kind") == "deep" and j.get("key") == key and j.get("status") in {"queued", "running"}:
            return j
    return None


def _run_job(service: WebAcquisitionService, job: dict[str, Any]) -> None:
    kind, params = job["kind"], job["params"]

    def progress(done: int, total: int) -> None:
        job.update(completed=done, total=total)
        _write(job)

    try:
        if kind == "deep":
            from . import deepresearch, wiki

            def note(msg: str, feynman_job_id: str | None = None) -> None:
                job["note"] = msg
                if feynman_job_id:
                    job["feynman_job_id"] = feynman_job_id  # lets a restarted service re-attach to the same run
                _write(job)

            if job.get("feynman_job_id") is None:
                job.update(status="queued", note="waiting for the Feynman slot")
                _write(job)
            with _deep_gate:
                job.update(status="running", note=None)
                _write(job)
                res = deepresearch.run_deep(params["workflow"], params.get("topic", ""), note,
                    resume_job_id=job.get("feynman_job_id"), resume_run_id=params.get("resume_run_id"),
                    profile=params.get("profile"), tier=params.get("tier"), budget_usd=params.get("budget_usd"),
                    register=params.get("register"), inference_depth=params.get("inference_depth"),
                    domain_notes=params.get("domain_notes"))
            if params.get("to_wiki"):
                res.update(wiki.file_deliverable(params.get("title") or params["topic"][:80], res["deliverable"], res["path"]))
            job["result"] = res
        elif kind == "crawl":
            job["result"] = crawl_site(service, progress=progress, **params)
        else:  # batch
            urls, mc = params["urls"], params.get("max_chars", 8000)
            results = []
            job["total"] = len(urls)
            for i in range(0, len(urls), 5):
                results += service.crawl(urls[i:i + 5], mc, mode=params.get("mode", "auto"))["results"]
                progress(len(results), len(urls))
            job["result"] = {"count": len(results), "results": results}
        job["status"] = "completed"
    except Exception as err:
        job.update(status="failed", error=f"{type(err).__name__}: {str(err)[:300]}")
    _write(job)


def start_job(service: WebAcquisitionService, kind: str, params: dict[str, Any]) -> dict[str, Any]:
    key = _deep_key(params) if kind == "deep" else None
    if key:
        with _lock:  # two callers asking for the same research get the same job
            existing = _active_deep(key)
        if existing:
            return {"job_id": existing["id"], "status": existing["status"], "deduplicated": True}
    job = {"id": str(uuid.uuid4()), "kind": kind, "params": params, "key": key, "status": "running", "completed": 0,
           "total": None, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "result": None, "error": None}
    _write(job)
    threading.Thread(target=_run_job, args=(service, job), daemon=True).start()
    return {"job_id": job["id"], "status": "running"}


def job_status(job_id: str, include_results: bool = False, offset: int = 0, limit: int = 10) -> dict[str, Any]:
    try:
        job = json.loads(_path(job_id).read_text())
    except FileNotFoundError:
        return {"job_id": job_id, "status": "unknown", "error": "no such job"}
    result = job.pop("result", None)
    job.pop("params", None)
    out = {"job_id": job["id"], "kind": job["kind"], "status": job["status"], "completed": job["completed"],
           "total": job["total"], "error": job["error"]}
    if job.get("feynman_job_id"):
        out["run_id"] = job["feynman_job_id"]
    if job.get("note"):
        out["note"] = job["note"]
    if result is not None and job["kind"] == "deep":
        out["research_status"] = result.get("status")
        out.update({k: v for k, v in result.items() if k not in ("deliverable", "status")})
        if include_results:
            out["deliverable"] = result["deliverable"][offset:offset + 20000] if offset or limit else result["deliverable"]
            out["deliverable_truncated"] = len(result["deliverable"]) > offset + 20000
        return out
    if result is not None:
        key = "pages" if "pages" in result else "results"
        out["count"] = result.get("count", 0)
        out["stopped"] = result.get("stopped")
        if include_results:
            out["offset"], out[key] = offset, result[key][offset:offset + max(1, min(limit, 50))]
    return out


# ---- daemon-backed jobs ---------------------------------------------------------------------
# Jobs started through the always-on web-agent service survive the caller's MCP session. State is on disk,
# so any process can read status. If the service is not reachable the job runs in-process instead.

DAEMON_URL = os.getenv("WEB_MCP_JOBS_URL", "http://127.0.0.1:42619").rstrip("/")
DAEMON_TOKEN_FILE = Path(os.getenv("WEB_AGENT_A2A_TOKEN_FILE", "~/.config/web-agent-deep/a2a-token")).expanduser()


def start(service: WebAcquisitionService, kind: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        req = urllib.request.Request(
            f"{DAEMON_URL}/jobs", data=json.dumps({"kind": kind, "params": params}).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {DAEMON_TOKEN_FILE.read_text().strip()}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return {**json.load(r), "runs_in": "web-agent service (survives this session)"}
    except (OSError, ValueError):
        return {**start_job(service, kind, params), "runs_in": "this process (ends with the session)"}


def recover(service: WebAcquisitionService | None = None) -> dict[str, int]:
    """At service start: crawl/batch jobs still marked running belong to a dead process and fail; deep jobs resume
    (re-attaching to the Feynman run when its id was saved, else starting again)."""
    failed = resumed = 0
    for f in sorted(STATE_DIR.glob("*.json")) if STATE_DIR.exists() else []:
        try:
            job = json.loads(f.read_text())
        except ValueError:
            continue
        if job.get("status") not in {"running", "queued"}:
            continue
        if job.get("kind") == "deep" and service is not None and job.get("params"):
            job.update(status="queued", note="resuming after a service restart")
            _write(job)
            threading.Thread(target=_run_job, args=(service, job), daemon=True).start()
            resumed += 1
        else:
            job.update(status="failed", error="interrupted: the service restarted while this job ran")
            _write(job)
            failed += 1
    return {"failed": failed, "resumed": resumed}
