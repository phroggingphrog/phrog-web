from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from lxml import html as lxml_html

from . import fetch
from . import sources as sources_mod


MIN_BLOCK_CHARS = 200
MIN_BATCH_S = 20.0
# Plain HTML must beat this to skip the browser (JS shells and teasers are short).
MIN_HTML_CHARS = 500
# Share of a crawl's budget the plain phase may use in auto mode.
PLAIN_BUDGET_SHARE = 0.45
TIME_RANGES = {"day", "week", "month", "year"}


class UpstreamError(RuntimeError):
    """An upstream search/crawl request failed."""


@dataclass(frozen=True)
class Settings:
    searxng_url: str = os.getenv("SEARXNG_URL", "http://127.0.0.1:8888").rstrip("/")
    crawl4ai_url: str = os.getenv("CRAWL4AI_URL", "http://127.0.0.1:11235").rstrip("/")
    crawl4ai_api_token: str = os.getenv("CRAWL4AI_API_TOKEN", "")
    # Second Crawl4AI with a different egress IP (homelab); retried for failed/blocked URLs.
    crawl4ai_fallback_url: str = os.getenv("CRAWL4AI_FALLBACK_URL", "").rstrip("/")
    # host:port of the tencentvps egress proxy for plain fetches (privoxy); empty = direct only.
    plain_proxy: str = os.getenv("WEB_MCP_PLAIN_PROXY", "")
    plain_timeout_s: float = float(os.getenv("WEB_MCP_PLAIN_TIMEOUT_S", "20"))
    # Whole-call budget for web_crawl; keep under the MCP client's tool timeout (120s).
    crawl_budget_s: float = float(os.getenv("WEB_MCP_CRAWL_BUDGET_S", "100"))
    request_timeout_s: float = float(os.getenv("WEB_MCP_REQUEST_TIMEOUT_S", "45"))
    max_urls: int = int(os.getenv("WEB_MCP_MAX_URLS", "10"))
    max_markdown_chars: int = int(os.getenv("WEB_MCP_MAX_MARKDOWN_CHARS", "50000"))
    allow_private_urls: bool = os.getenv("ALLOW_PRIVATE_URLS", "0").lower() in {"1", "true", "yes"}
    # Keep under the MCP client's tool timeout (Hermes docs use 120s).
    deep_search_budget_s: float = float(os.getenv("WEB_MCP_DEEP_SEARCH_BUDGET_S", "100"))


def _json_request(request: Request, timeout: float) -> Any:
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except HTTPError as exc:
        body = exc.read(500).decode("utf-8", "replace")
        raise UpstreamError(f"upstream returned HTTP {exc.code}: {body}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise UpstreamError(f"upstream request failed: {exc}") from exc
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpstreamError("upstream returned invalid JSON") from exc


def _map_search_results(raw_results: Any, limit: int, engine_label: str | None = None) -> list[dict[str, Any]]:
    """Normalize SearXNG or OmniRoute result rows into one shape."""
    results: list[dict[str, Any]] = []
    for item in raw_results or []:
        if not isinstance(item, dict) or not item.get("url"):
            continue
        if engine_label is None:
            engines = [str(engine) for engine in item.get("engines") or []]
        else:
            engines = [engine_label]
        results.append({
            "title": str(item.get("title") or item["url"]),
            "url": str(item["url"]),
            "snippet": str(item.get("content") or item.get("snippet") or ""),
            "published_date": str(item.get("publishedDate") or item.get("published_at") or "") or None,
            "engines": engines,
        })
        if len(results) >= limit:
            break
    return results

def _validate_public_url(value: str, allow_private: bool) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"only absolute http(s) URLs are allowed: {value!r}")
    if parsed.username or parsed.password:
        raise ValueError("URLs containing username/password credentials are not allowed")
    if len(url) > 4096:
        raise ValueError("URL exceeds 4096 characters")
    if allow_private:
        return url
    fetch.public_ips(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), allow_private=False)
    return url


def _markdown_from_result(result: dict[str, Any]) -> str:
    markdown = result.get("markdown", "")
    if isinstance(markdown, dict):
        return str(markdown.get("fit_markdown") or markdown.get("raw_markdown") or markdown.get("markdown_with_citations") or "")
    return str(markdown or result.get("extracted_content") or "")


def _make_item(*, url: str, requested_url: str | None, content: str, max_chars: int, **fields: Any) -> dict[str, Any]:
    returned = content[:max_chars]
    return {
        "url": url,
        "requested_url": requested_url,
        **fields,
        "markdown": returned,
        "truncated": len(content) > max_chars,
        "total_chars": len(content),
        # sha256 verifies exactly the returned text; full_sha256 the whole page.
        "sha256": hashlib.sha256(returned.encode("utf-8")).hexdigest(),
        "full_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }


def _result_key(item: dict[str, Any]) -> str:
    return str(item.get("requested_url") or item.get("url") or "").rstrip("/")


def _content_from_result(result: dict[str, Any]) -> str:
    """Prefer the pruned fit_markdown, but fall back to raw when pruning left too little."""
    markdown = result.get("markdown")
    if isinstance(markdown, dict):
        fit = str(markdown.get("fit_markdown") or "").strip()
        raw = str(markdown.get("raw_markdown") or "").strip()
        if len(fit) >= MIN_BLOCK_CHARS or not raw:
            return fit
        return raw
    return _markdown_from_result(result).strip()


# Phrases from bot-check interstitials (Cloudflare, DataDome, Akamai, reCAPTCHA
# walls). Only checked against short pages, so an article that merely mentions
# CAPTCHAs is not flagged.
_CHALLENGE_MARKERS = (
    "performing security verification",
    "verify you are human",
    "checking your browser",
    "just a moment...",
    "enable javascript and cookies to continue",
    "access denied",
    "unusual traffic from your computer",
    "please complete the security check",
    "you need to enable javascript",
    "please enable javascript",
    "javascript is required",
)


def _challenge_reason(content: str, status_code: Any) -> str | None:
    if len(content) > 3000:
        return None
    lowered = content.lower()
    for marker in _CHALLENGE_MARKERS:
        if marker in lowered:
            return f"blocked by bot check ({marker!r}, status {status_code})"
    return None


CRAWLER_CONFIG = {
    "type": "CrawlerRunConfig",
    "params": {
        "markdown_generator": {
            "type": "DefaultMarkdownGenerator",
            "params": {
                "content_filter": {"type": "PruningContentFilter", "params": {"threshold": 0.48, "threshold_type": "dynamic"}},
                "options": {"ignore_images": True},
            },
        },
        "excluded_tags": ["nav", "header", "footer", "aside", "form"],
        "remove_overlay_elements": True,
    },
}


_tls = threading.local()  # per-call browser options; calls from different threads must not share them
ACTION_TYPES = {"click", "type", "press", "scroll", "wait", "wait_for"}
MAX_ACTIONS = 20


def compile_actions(actions: list[dict[str, Any]]) -> list[str]:
    """Turn page actions into /execute_js scripts (each an async IIFE; they run in order on one loaded page)."""
    if not isinstance(actions, list) or len(actions) > MAX_ACTIONS:
        raise ValueError(f"actions must be a list of at most {MAX_ACTIONS} steps")
    scripts: list[str] = []
    q = json.dumps
    for step in actions:
        kind = step.get("type") if isinstance(step, dict) else None
        if kind not in ACTION_TYPES:
            raise ValueError(f"action type must be one of {sorted(ACTION_TYPES)}")
        sel = step.get("selector")
        if kind in {"click", "type", "wait_for"} and (not isinstance(sel, str) or not sel or len(sel) > 200):
            raise ValueError(f"{kind} needs a CSS selector (max 200 chars)")
        if kind == "click":
            body = f"const e=document.querySelector({q(sel)});if(!e)return 'no match: '+{q(sel)};e.click();return 'clicked';"
        elif kind == "type":
            text = str(step.get("text", ""))[:2000]
            body = (f"const e=document.querySelector({q(sel)});if(!e)return 'no match: '+{q(sel)};e.focus();e.value={q(text)};"
                    "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'typed';")
        elif kind == "press":
            key = str(step.get("key", "Enter"))[:20]
            body = (f"const e=document.querySelector({q(sel or 'body')})||document.body;"
                    f"e.dispatchEvent(new KeyboardEvent('keydown',{{key:{q(key)},bubbles:true}}));"
                    f"if({q(key)}==='Enter'&&e.form){{e.form.requestSubmit?e.form.requestSubmit():e.form.submit();}}return 'pressed';")
        elif kind == "scroll":
            to = step.get("to", "bottom")
            if to == "bottom":
                body = ("let last=-1;for(let i=0;i<30&&document.body.scrollHeight!==last;i++){last=document.body.scrollHeight;"
                        "window.scrollTo(0,last);await new Promise(r=>setTimeout(r,700));}return 'scrolled';")
            elif to == "top":
                body = "window.scrollTo(0,0);return 'top';"
            else:
                body = f"window.scrollTo(0,{int(to)});return 'scrolled';"
        elif kind == "wait":
            body = f"await new Promise(r=>setTimeout(r,{max(0, min(int(step.get('ms', 500)), 10000))}));return 'waited';"
        else:  # wait_for
            body = (f"for(let i=0;i<40;i++){{if(document.querySelector({q(sel)}))return 'found';"
                    "await new Promise(r=>setTimeout(r,250));}return 'timeout';")
        scripts.append(f"(async()=>{{{body}}})()")
    # /execute_js runs as soon as the page loads, before scripts that build the page have finished: settle first.
    settle = "(async()=>{for(let i=0;i<20&&document.readyState!=='complete';i++)await new Promise(r=>setTimeout(r,250));await new Promise(r=>setTimeout(r,1200));return 'settled';})()"
    return [settle, *scripts]


# Crawl4AI refuses js_code/magic/simulate_user from API requests; these are the anti-detection knobs it allows.
STEALTH_BROWSER = {"type": "BrowserConfig", "params": {"enable_stealth": True, "user_agent_mode": "random"}}
STEALTH_RUN = {"delay_before_return_html": 1.5, "scan_full_page": True}


class WebAcquisitionService:
    accept_short = False  # agent fallback: keep short plain pages when no browser crawler is reachable

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or Settings()

    def search(
        self,
        query: str,
        limit: int = 5,
        time_range: str | None = None,
        language: str | None = None,
        categories: str | None = None,
        engines: str | None = None,
    ) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("query must not be empty")
        limit = max(1, min(int(limit), 20))
        params = {"q": query, "format": "json"}
        if time_range:
            if time_range not in TIME_RANGES:
                raise ValueError(f"time_range must be one of {sorted(TIME_RANGES)}")
            params["time_range"] = time_range
        if language:
            params["language"] = language
        if categories:
            params["categories"] = categories
        if engines:
            params["engines"] = engines
        url = f"{self.settings.searxng_url}/search?{urlencode(params)}"
        searxng_error: UpstreamError | None = None
        try:
            payload = _json_request(Request(url, headers={"Accept": "application/json", "User-Agent": "self-hosted-web-mcp/0.1"}), self.settings.request_timeout_s)
        except UpstreamError as exc:
            payload, searxng_error = None, exc
        raw_results = payload.get("results", []) if isinstance(payload, dict) else []
        results = _map_search_results(raw_results, limit)
        if results:
            return {"query": query, "results": results, "count": len(results), "provider": "searxng"}
        # SearXNG down or empty: OmniRoute's search API (duckduckgo-free) keeps the tool answering.
        try:
            fallback = self._search_omniroute(query, limit)
        except UpstreamError as exc:
            raise searxng_error or exc
        return {**fallback, "query": query}

    def _search_omniroute(self, query: str, limit: int) -> dict[str, Any]:
        from . import deep_agent  # local import: deep_agent imports this module

        base = os.getenv("OMNIROUTE_SEARCH_URL", "http://127.0.0.1:20128").rstrip("/")
        try:
            key = deep_agent._api_key()
        except Exception as exc:
            raise UpstreamError(f"omniroute search key unavailable: {exc}") from exc
        request = Request(
            f"{base}/v1/search",
            data=json.dumps({"query": query, "max_results": limit}).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        payload = _json_request(request, self.settings.request_timeout_s)
        provider = str(payload.get("provider") or "omniroute") if isinstance(payload, dict) else "omniroute"
        raw_results = payload.get("results", []) if isinstance(payload, dict) else []
        results = _map_search_results(raw_results, limit, engine_label=provider)
        return {"results": results, "count": len(results), "provider": "omniroute"}

    def crawl(
        self, urls: list[str], max_chars: int = 12000, timeout: float | None = None, mode: str = "auto",
        actions: list[dict[str, Any]] | None = None, stealth: bool = False,
    ) -> dict[str, Any]:
        """mode: auto (plain fetch, browser for what it cannot handle) | plain | browser.

        actions (click/type/press/scroll/wait/wait_for) and stealth force the browser; see compile_actions.
        """
        if actions or stealth:
            mode = "browser"
        run_extra = dict(STEALTH_RUN) if stealth else {}
        scripts = None
        if actions:
            compiled = compile_actions(actions)  # also validates
            if any(a["type"] in {"click", "type", "press"} for a in actions):
                scripts = compiled  # interaction: /execute_js
            else:  # scroll / wait only: /crawl renders these reliably through its own allowed options
                for a in actions:
                    if a["type"] == "scroll" and a.get("to", "bottom") == "bottom":
                        run_extra["scan_full_page"] = True
                    elif a["type"] == "wait":
                        run_extra["delay_before_return_html"] = max(run_extra.get("delay_before_return_html", 0), min(int(a.get("ms", 500)), 10000) / 1000)
                    elif a["type"] == "wait_for":
                        run_extra["wait_for"] = f"css:{a['selector']}"
        _tls.scripts, _tls.stealth = scripts, bool(stealth)
        _tls.extra = run_extra
        if mode not in {"auto", "plain", "browser"}:
            raise ValueError("mode must be auto, plain, or browser")
        max_chars = max(500, min(int(max_chars), self.settings.max_markdown_chars))
        # `timeout` is the budget for the whole call (plain phase + browser + fallback).
        budget = min(timeout, self.settings.crawl_budget_s) if timeout else self.settings.crawl_budget_s
        deadline = time.monotonic() + budget
        if not isinstance(urls, list) or not urls:
            raise ValueError("urls must be a non-empty list")
        if len(urls) > self.settings.max_urls:
            raise ValueError(f"at most {self.settings.max_urls} URLs may be crawled per call")
        clean_urls: list[str] = []
        for value in urls:
            if not isinstance(value, str):
                raise ValueError("each URL must be a string")
            clean = _validate_public_url(value, self.settings.allow_private_urls)
            if clean not in clean_urls:
                clean_urls.append(clean)

        results: dict[str, dict[str, Any]] = {}
        if mode != "browser":
            # One parallel round; in auto mode it may use under half the budget so the
            # browser still has time. Stragglers (e.g. a slow PDF conversion) are abandoned.
            plain_budget = budget if mode == "plain" else budget * PLAIN_BUDGET_SHARE
            per_route = min(self.settings.plain_timeout_s, plain_budget / 2)
            pool = ThreadPoolExecutor(max_workers=len(clean_urls))
            futures = {pool.submit(self._plain_fetch, u, max_chars, per_route): u for u in clean_urls}
            done, _ = wait(futures, timeout=plain_budget)
            pool.shutdown(wait=False, cancel_futures=True)
            for future, url in futures.items():
                if future in done and future.exception() is None:
                    results[url.rstrip("/")] = future.result()
                else:
                    reason = f"plain fetch exceeded its {plain_budget:.0f}s share of the budget" if future not in done else repr(future.exception())
                    results[url.rstrip("/")] = {"requested_url": url, "url": url, "success": False, "error": reason, "fetcher": "plain"}
        need_browser = [u for u in clean_urls if not results.get(u.rstrip("/"), {}).get("success")] if mode != "plain" else []
        primary_error = None
        remaining = deadline - time.monotonic()
        if need_browser and remaining < MIN_BATCH_S / 2:
            for url in need_browser:
                results.setdefault(url.rstrip("/"), {"requested_url": url, "url": url, "success": False})["browser_error"] = "time budget exhausted"
            need_browser = []
        if need_browser:
            per_request = min(self.settings.request_timeout_s, remaining / (2 if self.settings.crawl4ai_fallback_url else 1))
            try:
                browser, primary_error = self._browser_crawl(need_browser, max_chars, per_request)
            except (UpstreamError, RuntimeError) as exc:
                # Keep plain-fetch successes; report the browser failure on the rest.
                if not any(item.get("success") for item in results.values()):
                    raise
                browser, primary_error = [], str(exc)
                for url in need_browser:
                    results.setdefault(url.rstrip("/"), {"requested_url": url, "url": url, "success": False})["browser_error"] = str(exc)
            for item in browser:
                key = _result_key(item)
                previous = results.get(key)
                if previous is not None and not previous.get("success"):
                    item["plain_error"] = previous.get("error")
                if item.get("success") or previous is None or not previous.get("success"):
                    results[key] = item
        ordered = [results[u.rstrip("/")] for u in clean_urls if u.rstrip("/") in results]
        ordered += [item for item in results.values() if item not in ordered]
        return {
            "success": any(item.get("success") for item in ordered),
            "results": ordered,
            "count": len(ordered),
            "primary_error": primary_error,
        }

    def _browser_crawl(self, clean_urls: list[str], max_chars: int, timeout: float) -> tuple[list[dict[str, Any]], str | None]:
        """Headless-browser crawl on the primary Crawl4AI, retrying failures on the fallback one."""
        if not self.settings.crawl4ai_api_token:
            raise RuntimeError("CRAWL4AI_API_TOKEN is not configured")
        fallback_url = self.settings.crawl4ai_fallback_url
        try:
            normalized = self._crawl_via(self.settings.crawl4ai_url, clean_urls, max_chars, "primary", timeout)
            primary_error = None
        except UpstreamError as exc:
            if not fallback_url:
                raise
            normalized, primary_error = [], str(exc)

        # Retry anything that failed or hit a bot check on the fallback crawler
        # (a different egress IP), keeping whichever attempt succeeded.
        if fallback_url:
            by_url = {_result_key(item): item for item in normalized}
            retry = [url for url in clean_urls if not by_url.get(url.rstrip("/"), {}).get("success")]
            if retry:
                try:
                    for item in self._crawl_via(fallback_url, retry, max_chars, "fallback", timeout):
                        key = _result_key(item)
                        previous = by_url.get(key)
                        if item["success"] or previous is None:
                            if previous is not None:
                                item["primary_error"] = previous.get("error")
                            by_url[key] = item
                        else:
                            previous["fallback_error"] = item.get("error") or f"status {item.get('status_code')}"
                except UpstreamError as exc:
                    if not by_url:
                        raise UpstreamError(f"primary: {primary_error}; fallback: {exc}") from exc
            normalized = list(by_url.values())
        return normalized, primary_error

    def _crawler_config(self) -> dict[str, Any]:
        extra = getattr(_tls, "extra", None) or {}
        return {**CRAWLER_CONFIG, "params": {**CRAWLER_CONFIG["params"], **extra}} if extra else CRAWLER_CONFIG

    def _crawl_via(self, base_url: str, clean_urls: list[str], max_chars: int, egress: str, timeout: float) -> list[dict[str, Any]]:
        def post(path: str, body: dict[str, Any]) -> Any:
            return _json_request(Request(
                f"{base_url}{path}", data=json.dumps(body).encode(), method="POST",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.settings.crawl4ai_api_token}",
                    "User-Agent": "self-hosted-web-mcp/0.1",
                },
            ), timeout)

        scripts = getattr(_tls, "scripts", None)
        if scripts:  # page actions: load, run the scripts in order, return the resulting page
            payload = {"results": [post("/execute_js", {"url": u, "scripts": scripts}) for u in clean_urls]}
        else:
            body = {"urls": clean_urls, "priority": 10, "crawler_config": self._crawler_config()}
            if getattr(_tls, "stealth", False):
                body["browser_config"] = STEALTH_BROWSER
            payload = post("/crawl", body)
        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        raw_results = payload.get("results", []) if isinstance(payload, dict) else []
        normalized: list[dict[str, Any]] = []
        for result in raw_results:
            if not isinstance(result, dict):
                continue
            result_url = str(result.get("url") or "")
            links = result.get("links") if isinstance(result.get("links"), dict) else {}
            internal = [str(x.get("href")) for x in links.get("internal") or [] if isinstance(x, dict) and x.get("href")]
            # Page cleaning drops nav/footer, which is where pagers live: read links from the raw HTML as well.
            raw_html = result.get("html")
            if isinstance(raw_html, str) and raw_html:
                try:
                    for href in lxml_html.fromstring(raw_html).xpath("//a/@href"):
                        absolute = urldefrag(urljoin(result_url, href.strip()))[0]
                        if absolute.startswith(("http://", "https://")) and absolute not in internal:
                            internal.append(absolute)
                except (ValueError, lxml_html.etree.ParserError):
                    pass
            requested_url = next((candidate for candidate in clean_urls if candidate.rstrip("/") == result_url.rstrip("/")), None)
            metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
            content = _content_from_result(result)
            error = str(result.get("error_message") or "") or None
            success = bool(result.get("success"))
            blocked = _challenge_reason(content, result.get("status_code"))
            if blocked:
                success, error = False, blocked
            normalized.append(_make_item(
                url=result_url, requested_url=requested_url, content=content, max_chars=max_chars,
                success=success, blocked=bool(blocked), status_code=result.get("status_code"),
                title=str(metadata.get("title") or ""), description=str(metadata.get("description") or ""),
                fetched_at=fetched_at, redirected_url=result.get("redirected_url"), error=error,
                egress=egress, fetcher="browser",
            ))
            normalized[-1]["links"] = internal[:300]
        return normalized

    def _plain_routes(self) -> list[tuple[str, tuple[str, int] | None]]:
        """(egress, proxy) pairs to try in order: tencentvps proxy first, then direct (homelab)."""
        routes: list[tuple[str, tuple[str, int] | None]] = []
        if self.settings.plain_proxy:
            host, _, port = self.settings.plain_proxy.rpartition(":")
            routes.append(("primary", (host, int(port))))
        routes.append(("fallback" if routes else "primary", None))
        return routes

    def research(
        self,
        query: str,
        sources: list[str] | None = None,
        preset: str = "academic",
        limit: int = 3,
        stackexchange_site: str = "stackoverflow",
    ) -> dict[str, Any]:
        def fetch_bytes(url: str, headers: dict[str, str]) -> bytes:
            errors: list[str] = []
            for egress, proxy in self._plain_routes():
                try:
                    return fetch.plain_get(url, self.settings.plain_timeout_s, False, proxy, headers)[3]
                except fetch.FetchError as exc:
                    errors.append(f"{egress}: {exc}")
            raise fetch.FetchError("; ".join(errors))

        return sources_mod.research_search(query, fetch_bytes, sources, preset, limit, stackexchange_site)

    def _plain_fetch(self, url: str, max_chars: int, timeout: float) -> dict[str, Any]:
        """Plain GET + conversion, via the tencentvps proxy first, then direct (homelab)."""
        errors: list[str] = []
        for egress, proxy in self._plain_routes():
            try:
                final_url, status, content_type, body = fetch.plain_get(url, timeout, self.settings.allow_private_urls, proxy)
                content, title, converter = fetch.convert(final_url, content_type, body)
            except fetch.FetchError as exc:
                errors.append(f"{egress}: {exc}")
                continue
            blocked = _challenge_reason(content, status)
            minimum = MIN_HTML_CHARS if converter == "trafilatura" else MIN_BLOCK_CHARS
            if blocked or (len(content) < minimum and not (self.accept_short and content.strip())):
                errors.append(f"{egress}: {blocked or f'only {len(content)} chars extracted by {converter}'}")
                continue
            item = _make_item(
                url=final_url, requested_url=url, content=content, max_chars=max_chars, success=True, blocked=False,
                status_code=status, title=title, description="", error=None,
                fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                redirected_url=final_url if final_url != url else None, egress=egress, fetcher=f"plain:{converter}",
            )
            item["content_type"] = content_type
            if errors:
                item["primary_error"] = errors[0]
            return item
        return {"requested_url": url, "url": url, "success": False, "error": "; ".join(errors), "fetcher": "plain"}

    def deep_search(
        self,
        query: str,
        num_sources: int = 3,
        time_range: str | None = None,
        language: str | None = None,
    ) -> dict[str, Any]:
        num_sources = max(1, min(int(num_sources), 10))
        deadline = time.monotonic() + self.settings.deep_search_budget_s
        search = self.search(query, limit=num_sources * 3, time_range=time_range, language=language)
        pool: list[dict[str, str]] = []
        skipped: list[dict[str, str]] = []
        seen: set[str] = set()
        for candidate in search["results"]:
            key = candidate["url"].rstrip("/")
            if key in seen:
                continue
            seen.add(key)
            try:
                _validate_public_url(candidate["url"], self.settings.allow_private_urls)
                pool.append(candidate)
            except ValueError as exc:
                skipped.append({"url": candidate["url"], "reason": str(exc)})
        # Crawl4AI returns batch results in completion order, so results are
        # matched back to their source by URL, never by position. Sources that
        # fail or come back near-empty are replaced from the remaining pool.
        blocks: list[dict[str, Any]] = []
        attempted = 0
        budget_exhausted = False
        while len(blocks) < num_sources and attempted < len(pool):
            # Each batch gets what is left of the budget; crawl() splits it across
            # the plain phase, browser and fallback so the call ends in time.
            remaining = deadline - time.monotonic()
            if attempted and remaining < MIN_BATCH_S:
                budget_exhausted = True
                break
            batch = pool[attempted: attempted + num_sources - len(blocks)]
            attempted += len(batch)
            try:
                crawled = self.crawl([item["url"] for item in batch], timeout=remaining)
            except UpstreamError as exc:
                # Keep the blocks already gathered; move on to the next batch.
                skipped.extend({"url": item["url"], "reason": f"crawl request failed: {exc}"} for item in batch)
                continue
            by_url: dict[str, dict[str, Any]] = {}
            for result in crawled.get("results", []):
                for value in (result.get("requested_url"), result.get("url"), result.get("redirected_url")):
                    if value:
                        by_url.setdefault(str(value).rstrip("/"), result)
            for source in batch:
                result = by_url.get(source["url"].rstrip("/"))
                content = (result.get("markdown", "") if result else "").strip()
                if result is None:
                    skipped.append({"url": source["url"], "reason": "no crawl result returned"})
                elif not result.get("success"):
                    reason = result.get("error") or f"crawl failed (status {result.get('status_code')})"
                    skipped.append({"url": source["url"], "reason": reason})
                elif len(content) < MIN_BLOCK_CHARS:
                    skipped.append({"url": source["url"], "reason": f"content too short ({len(content)} chars)"})
                else:
                    blocks.append({
                        "id": len(blocks) + 1,
                        "source": source,
                        "url": result.get("url") or source["url"],
                        "title": result.get("title") or source["title"],
                        "content": content,
                        "truncated": result.get("truncated", False),
                        "sha256": result.get("sha256"),
                        "fetched_at": result.get("fetched_at"),
                        "status_code": result.get("status_code"),
                    })
        return {
            "query": query.strip(),
            "sources_requested": num_sources,
            "sources_attempted": attempted,
            "sources_crawled": len(blocks),
            "budget_exhausted": budget_exhausted,
            "skipped": skipped,
            "context_blocks": blocks,
            "note": "Deterministic retrieval context; an LLM can synthesize the cited blocks downstream.",
        }
