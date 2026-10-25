"""Key-less research sources queried through their own APIs, in parallel.

Pattern from Obsidian Second Brain's ``/research`` free mode: official APIs
never show a bot check, and return structured metadata (authors, year,
citations, open-access PDF) that scraping a results page cannot. Requests go
through the same pinned plain fetcher as web pages (tencentvps first, homelab
direct second). Each source fails independently; errors are reported, not raised.
"""

from __future__ import annotations

import html
import json
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable
from urllib.parse import quote, urlencode

from . import fetch

API_UA = "phrog-research/0.1 (self-hosted research MCP; personal, low volume)"
SNIPPET_CHARS = 600
MAX_PER_SOURCE = 10
STACKEXCHANGE_SITES = {"stackoverflow", "stats", "math", "datascience", "dba", "softwareengineering", "superuser", "unix", "serverfault"}

Getter = Callable[[str], Any]


def _text(value: Any, limit: int = SNIPPET_CHARS) -> str:
    value = re.sub(r"<[^>]+>", "", html.unescape(str(value or "")))
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= limit else value[:limit].rstrip() + " …"


def _item(source: str, title: Any, url: Any, **fields: Any) -> dict[str, Any]:
    return {"source": source, "title": _text(title, 300), "url": url, **{k: v for k, v in fields.items() if v not in (None, "", [])}}


def _openalex_abstract(index: dict[str, list[int]] | None) -> str:
    if not index:
        return ""
    words = sorted((pos, word) for word, positions in index.items() for pos in positions)
    return " ".join(word for _, word in words)


def openalex(get: Getter, query: str, limit: int, **_: Any) -> list[dict[str, Any]]:
    data = get("https://api.openalex.org/works?" + urlencode({"search": query, "per-page": limit}))
    out = []
    for work in data.get("results", []):
        oa = work.get("open_access") or {}
        location = work.get("primary_location") or {}
        out.append(_item(
            "openalex", work.get("display_name"), location.get("landing_page_url") or work.get("doi") or work.get("id"),
            snippet=_text(_openalex_abstract(work.get("abstract_inverted_index"))),
            authors=[a["author"]["display_name"] for a in work.get("authorships", [])[:5] if a.get("author")],
            year=work.get("publication_year"), citations=work.get("cited_by_count"),
            doi=work.get("doi"), pdf_url=oa.get("oa_url"),
        ))
    return out


def arxiv(get: Getter, query: str, limit: int, **_: Any) -> list[dict[str, Any]]:
    # arXiv applies a field prefix to one term only and ORs the rest, so AND every term.
    terms = re.findall(r"[\w-]+", query)[:12]
    search = " AND ".join(f"all:{term}" for term in terms) or f'all:"{query}"'
    body = get("https://export.arxiv.org/api/query?" + urlencode({"search_query": search, "max_results": limit, "sortBy": "relevance"}), raw=True)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for entry in ET.fromstring(body).findall("a:entry", ns):
        link = entry.findtext("a:id", default="", namespaces=ns)
        pdf = next((l.get("href") for l in entry.findall("a:link", ns) if l.get("title") == "pdf"), None)
        out.append(_item(
            "arxiv", entry.findtext("a:title", namespaces=ns), link,
            snippet=_text(entry.findtext("a:summary", namespaces=ns)),
            authors=[a.findtext("a:name", namespaces=ns) for a in entry.findall("a:author", ns)][:5],
            year=(entry.findtext("a:published", default="", namespaces=ns)[:4] or None), pdf_url=pdf,
        ))
    return out


def semantic_scholar(get: Getter, query: str, limit: int, **_: Any) -> list[dict[str, Any]]:
    fields = "title,url,year,abstract,citationCount,authors,openAccessPdf,externalIds"
    data = get("https://api.semanticscholar.org/graph/v1/paper/search?" + urlencode({"query": query, "limit": limit, "fields": fields}))
    out = []
    for paper in data.get("data") or []:
        doi = (paper.get("externalIds") or {}).get("DOI")
        out.append(_item(
            "semantic_scholar", paper.get("title"), paper.get("url"),
            snippet=_text(paper.get("abstract")), authors=[a.get("name") for a in (paper.get("authors") or [])[:5]],
            year=paper.get("year"), citations=paper.get("citationCount"),
            doi=f"https://doi.org/{doi}" if doi else None, pdf_url=(paper.get("openAccessPdf") or {}).get("url"),
        ))
    return out


def crossref(get: Getter, query: str, limit: int, **_: Any) -> list[dict[str, Any]]:
    select = "DOI,title,author,issued,is-referenced-by-count,URL,abstract,container-title"
    # Repeated type filters are ORed; this drops figure/table/component DOIs.
    types = ",".join(f"type:{t}" for t in ("journal-article", "proceedings-article", "book-chapter", "book", "posted-content"))
    data = get("https://api.crossref.org/works?" + urlencode({"query": query, "rows": limit, "select": select, "filter": types}))
    out = []
    for work in (data.get("message") or {}).get("items", []):
        issued = ((work.get("issued") or {}).get("date-parts") or [[None]])[0]
        out.append(_item(
            "crossref", (work.get("title") or [""])[0], work.get("URL"),
            snippet=_text(work.get("abstract")), venue=(work.get("container-title") or [None])[0],
            authors=[" ".join(filter(None, (a.get("given"), a.get("family")))) for a in (work.get("author") or [])[:5]],
            year=issued[0] if issued else None, citations=work.get("is-referenced-by-count"),
            doi=f"https://doi.org/{work['DOI']}" if work.get("DOI") else None,
        ))
    return out


def wikipedia(get: Getter, query: str, limit: int, **_: Any) -> list[dict[str, Any]]:
    data = get("https://en.wikipedia.org/w/rest.php/v1/search/page?" + urlencode({"q": query, "limit": limit}))
    return [
        _item("wikipedia", page.get("title"), "https://en.wikipedia.org/wiki/" + quote(page.get("key") or ""),
              snippet=_text(page.get("excerpt")) or _text(page.get("description")))
        for page in data.get("pages", [])
    ]


def hackernews(get: Getter, query: str, limit: int, **_: Any) -> list[dict[str, Any]]:
    data = get("https://hn.algolia.com/api/v1/search?" + urlencode({"query": query, "tags": "story", "hitsPerPage": limit}))
    return [
        _item("hackernews", hit.get("title"), hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
              discussion=f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
              points=hit.get("points"), comments=hit.get("num_comments"), year=(hit.get("created_at") or "")[:4] or None)
        for hit in data.get("hits", [])
    ]


def stackexchange(get: Getter, query: str, limit: int, stackexchange_site: str = "stackoverflow", **_: Any) -> list[dict[str, Any]]:
    if stackexchange_site not in STACKEXCHANGE_SITES:
        raise ValueError(f"stackexchange_site must be one of {sorted(STACKEXCHANGE_SITES)}")
    params = {"order": "desc", "sort": "relevance", "q": query, "site": stackexchange_site, "pagesize": limit, "filter": "withbody"}
    data = get("https://api.stackexchange.com/2.3/search/advanced?" + urlencode(params))
    return [
        _item("stackexchange", q.get("title"), q.get("link"), snippet=_text(q.get("body")), score=q.get("score"),
              answers=q.get("answer_count"), answered=q.get("is_answered"), site=stackexchange_site)
        for q in data.get("items", [])
    ]


SOURCES: dict[str, Callable[..., list[dict[str, Any]]]] = {
    "openalex": openalex,
    "arxiv": arxiv,
    "semantic_scholar": semantic_scholar,
    "crossref": crossref,
    "wikipedia": wikipedia,
    "hackernews": hackernews,
    "stackexchange": stackexchange,
}
PRESETS = {
    "academic": ["openalex", "arxiv", "semantic_scholar", "crossref", "wikipedia"],
    "tech": ["stackexchange", "hackernews", "wikipedia"],
    "all": list(SOURCES),
}


def research_search(
    query: str,
    fetch_bytes: Callable[[str, dict[str, str]], bytes],
    sources: list[str] | None = None,
    preset: str = "academic",
    limit: int = 3,
    stackexchange_site: str = "stackoverflow",
) -> dict[str, Any]:
    query = query.strip()
    if not query:
        raise ValueError("query must not be empty")
    if sources:
        unknown = sorted(set(sources) - set(SOURCES))
        if unknown:
            raise ValueError(f"unknown sources {unknown}; choose from {sorted(SOURCES)}")
        chosen = list(dict.fromkeys(sources))
    else:
        if preset not in PRESETS:
            raise ValueError(f"preset must be one of {sorted(PRESETS)}")
        chosen = PRESETS[preset]
    limit = max(1, min(int(limit), MAX_PER_SOURCE))

    def get(url: str, raw: bool = False) -> Any:
        body = fetch_bytes(url, {"User-Agent": API_UA, "Accept": "application/json, application/atom+xml;q=0.9"})
        return body if raw else json.loads(body.decode("utf-8"))

    def run(name: str) -> tuple[str, list[dict[str, Any]] | None, str | None]:
        try:
            return name, SOURCES[name](get, query, limit, stackexchange_site=stackexchange_site), None
        except Exception as exc:  # one broken source must not sink the others
            return name, None, f"{type(exc).__name__}: {str(exc)[:200]}"

    results: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=len(chosen)) as pool:
        for name, items, error in pool.map(run, chosen):
            if error:
                errors[name] = error
            else:
                results.extend(items or [])
    return {"query": query, "sources": chosen, "count": len(results), "results": results, "errors": errors}
