"""phrog-web: self-hosted search + extract for Hermes's native web tools.

Search goes to ``GET /api/search`` (TinyFish free tier → Exa → local SearXNG fallback).
Extract goes to ``POST /api/scrape``, which returns markdown, HTML, links and — when a login jar
exists for the site — authenticated content, in a single page visit.

No API key: phrog-web owns the upstream credentials, so ``PHROG_WEB_URL`` is the only setting.

Self-contained on purpose: this imports only the public ``agent.web_search_provider`` ABC and builds
the documented response envelope itself. Hermes's ``plugins.web._common`` is an in-tree seam and
third-party plugins are not allowed to import it.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://127.0.0.1:8890"


def _base_url() -> str:
    """phrog-web base URL. Falls back to loopback, which is where the service runs."""
    raw = (os.getenv("PHROG_WEB_URL", "") or "").strip() or DEFAULT_URL
    return raw.rstrip("/")


def _search_ok(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"success": True, "data": {"web": rows}}


def _search_fail(message: str) -> Dict[str, Any]:
    return {"success": False, "error": message}


def _hit(url: str, title: str, description: str, position: int) -> Dict[str, Any]:
    return {"title": str(title), "url": str(url), "description": str(description), "position": position}


def _document(url: str, title: str, content: str) -> Dict[str, Any]:
    return {"url": url, "title": str(title), "content": content, "raw_content": content}


def _page_error(url: str, error: str) -> Dict[str, Any]:
    return {"url": url, "error": error, "title": ""}


class PhrogWebSearchProvider(WebSearchProvider):
    """Search and extract via the self-hosted phrog-web API."""

    @property
    def name(self) -> str:
        return "phrog-web"

    @property
    def display_name(self) -> str:
        return "phrog-web (self-hosted)"

    def is_available(self) -> bool:
        # Cheap and offline: phrog-web runs on this box. A remote deployment sets PHROG_WEB_URL.
        return True

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    # --- search -------------------------------------------------------------------------
    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        import httpx

        base = _base_url()
        try:
            resp = httpx.get(
                f"{base}/api/search",
                params={"q": query, "limit": max(1, min(int(limit), 20))},
                headers={"Accept": "application/json"},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            return _search_fail(f"phrog-web returned HTTP {exc.response.status_code}: {(exc.response.text or '')[:200]}")
        except httpx.HTTPError as exc:
            return _search_fail(f"Could not reach phrog-web at {base}: {exc}")
        except ValueError:
            return _search_fail("Could not parse phrog-web search response as JSON")

        rows = [
            _hit(r.get("url", ""), r.get("title", ""), r.get("snippet", ""), i + 1)
            for i, r in enumerate(data.get("results", [])[:limit])
        ]
        logger.info(
            "phrog-web search %r: %d results via %s (plan %s)",
            query, len(rows), data.get("provider_used"), data.get("tinyfishPlan"),
        )
        return _search_ok(rows)

    # --- extract ------------------------------------------------------------------------
    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        import httpx

        base = _base_url()
        out: List[Dict[str, Any]] = []
        for url in urls:
            payload: Dict[str, Any] = {
                "url": url,
                "formats": ["markdown", "links"],
                "profile": True,  # attach a saved login jar for this site when one exists
            }
            if kwargs.get("max_chars"):
                payload["maxChars"] = int(kwargs["max_chars"])
            try:
                resp = httpx.post(f"{base}/api/scrape", json=payload, timeout=120)
            except httpx.HTTPError as exc:
                out.append(_page_error(url, f"Could not reach phrog-web at {base}: {exc}"))
                continue
            if resp.status_code >= 400:
                try:
                    detail = resp.json().get("error", "")
                except ValueError:
                    detail = (resp.text or "")[:200]
                out.append(_page_error(url, f"phrog-web scrape HTTP {resp.status_code}: {str(detail)[:200]}"))
                continue
            data = resp.json()
            content = data.get("markdown") or data.get("html") or ""
            if not content.strip():
                out.append(_page_error(url, "phrog-web returned no readable content"))
                continue
            doc = _document(url, data.get("title") or "", content)
            doc["metadata"] = {
                "provider_used": data.get("provider_used"),
                "links": len(data.get("links") or []),
                "title": data.get("title") or "",
            }
            out.append(doc)
        return out

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "phrog-web",
            "badge": "free · self-hosted",
            "tag": "Self-hosted search + extract. Owns every upstream key, so no vendor credential is needed here.",
            "env_vars": [
                {"key": "PHROG_WEB_URL", "prompt": "phrog-web base URL", "url": DEFAULT_URL},
            ],
        }
