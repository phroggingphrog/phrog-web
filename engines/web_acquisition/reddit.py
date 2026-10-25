"""Bounded Reddit digests via the homelab-IP Crawl4AI.

Reddit blocks both the tencentvps exit and plain HTTP clients, but a real
browser on the homelab IP can load Reddit's public ``.json`` endpoints. Chromium
renders those as ``<pre>`` text, which is parsed here. Every call is capped
(threads, comments, reply depth, text length) so an agent summarises a
discussion instead of wandering through it.
"""

from __future__ import annotations

import html
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request

from .service import TIME_RANGES, UpstreamError, _json_request

MAX_THREADS = 5
MAX_COMMENTS = 30
MAX_DEPTH = 2  # top-level comments plus one level of replies
MAX_COMMENT_CHARS = 1200
MAX_POST_CHARS = 3000
MAX_LISTING = 25

REDDIT_TIME_RANGES = TIME_RANGES | {"hour", "all"}
_SUBREDDIT_RE = re.compile(r"^[A-Za-z0-9_]{2,21}$")
_THREAD_RE = re.compile(r"^/r/([A-Za-z0-9_]{2,21})/comments/([a-z0-9]{3,12})(?:/|$)")
_PRE_RE = re.compile(r"<pre[^>]*>(.*?)</pre>", re.S)
_SKIP_AUTHORS = {"AutoModerator", "[deleted]"}

SUMMARY_FORMAT = (
    "Summarise for the user in this fixed shape, then stop: "
    "1) Bottom line (2-3 sentences). "
    "2) Where people agree. "
    "3) Where they disagree or warn. "
    "4) Best answers: at most 5, each with its score and permalink. "
    "5) Worth opening? yes/no and why. "
    "Do not fetch more threads or subreddits unless the user asks."
)


@dataclass(frozen=True)
class RedditSettings:
    # Defaults to the homelab crawler; the tencentvps one is blocked by Reddit.
    crawl4ai_url: str = (
        os.getenv("REDDIT_CRAWL4AI_URL") or os.getenv("CRAWL4AI_FALLBACK_URL") or "http://127.0.0.1:11236"
    ).rstrip("/")
    crawl4ai_api_token: str = os.getenv("CRAWL4AI_API_TOKEN", "")
    request_timeout_s: float = float(os.getenv("REDDIT_REQUEST_TIMEOUT_S", "90"))


def _iso(created_utc: Any) -> str | None:
    try:
        return datetime.fromtimestamp(float(created_utc), timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return None


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " …"


def _thread_path(value: str) -> tuple[str, str]:
    """Return (subreddit, thread_id) from a Reddit thread URL or permalink."""
    parsed = urlparse(value.strip() if "://" in value else "https://www.reddit.com" + value.strip())
    host = (parsed.hostname or "").lower()
    if host not in {"reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"}:
        raise ValueError(f"not a reddit.com thread URL: {value!r}")
    match = _THREAD_RE.match(parsed.path)
    if not match:
        raise ValueError(f"URL is not a Reddit comment thread: {value!r}")
    return match.group(1), match.group(2)


def _check_subreddit(name: str | None) -> str | None:
    if name is None or name == "":
        return None
    name = name.strip().removeprefix("r/").removeprefix("/r/")
    if not _SUBREDDIT_RE.match(name):
        raise ValueError(f"invalid subreddit name: {name!r}")
    return name


def _check_time_range(value: str) -> str:
    if value not in REDDIT_TIME_RANGES:
        raise ValueError(f"time_range must be one of {sorted(REDDIT_TIME_RANGES)}")
    return value


def _post_summary(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": data.get("id"),
        "title": data.get("title"),
        "subreddit": data.get("subreddit"),
        "score": data.get("score"),
        "num_comments": data.get("num_comments"),
        "created": _iso(data.get("created_utc")),
        "permalink": "https://www.reddit.com" + str(data.get("permalink") or ""),
        "link_url": None if data.get("is_self") else data.get("url"),
        "flair": data.get("link_flair_text"),
    }


def _flatten_comments(children: list[dict[str, Any]], max_comments: int, op: str | None) -> tuple[list[dict[str, Any]], int]:
    """Top comments by score, each followed by its best replies, within the caps."""
    picked: list[dict[str, Any]] = []
    omitted = 0

    def usable(node: dict[str, Any]) -> bool:
        data = node.get("data") or {}
        body = data.get("body") or ""
        return (
            node.get("kind") == "t1"
            and data.get("author") not in _SKIP_AUTHORS
            and body not in {"[deleted]", "[removed]"}
            and not data.get("stickied")
        )

    def walk(nodes: list[dict[str, Any]], depth: int) -> None:
        nonlocal omitted
        ranked = sorted((n for n in nodes if usable(n)), key=lambda n: n["data"].get("score") or 0, reverse=True)
        for node in ranked:
            if len(picked) >= max_comments:
                omitted += 1
                continue
            data = node["data"]
            picked.append({
                "depth": depth,
                "score": data.get("score"),
                "is_op": bool(op) and data.get("author") == op,
                "body": _clip(data.get("body") or "", MAX_COMMENT_CHARS),
                "permalink": "https://www.reddit.com" + str(data.get("permalink") or ""),
            })
            replies = data.get("replies")
            if depth + 1 < MAX_DEPTH and isinstance(replies, dict):
                walk((replies.get("data") or {}).get("children") or [], depth + 1)
            elif isinstance(replies, dict):
                omitted += sum(1 for n in (replies.get("data") or {}).get("children") or [] if n.get("kind") == "t1")

    walk(children, 0)
    return picked, omitted


class RedditDigestService:
    def __init__(self, settings: RedditSettings | None = None) -> None:
        self.settings = settings or RedditSettings()

    def _fetch_json(self, urls: list[str]) -> dict[str, Any]:
        """Crawl Reddit .json URLs; return {requested_url: parsed JSON or Exception}."""
        if not self.settings.crawl4ai_api_token:
            raise RuntimeError("CRAWL4AI_API_TOKEN is not configured")
        request = Request(
            f"{self.settings.crawl4ai_url}/crawl",
            data=json.dumps({"urls": urls, "priority": 10}).encode(),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.settings.crawl4ai_api_token}",
            },
            method="POST",
        )
        payload = _json_request(request, self.settings.request_timeout_s)
        out: dict[str, Any] = {}
        for result in payload.get("results", []) if isinstance(payload, dict) else []:
            url = str(result.get("url") or "")
            key = next((u for u in urls if u == url or u.split("?")[0] == url.split("?")[0]), url)
            match = _PRE_RE.search(str(result.get("html") or ""))
            if not result.get("success") or not match:
                out[key] = UpstreamError(
                    f"Reddit fetch failed (status {result.get('status_code')}): "
                    f"{result.get('error_message') or 'no JSON in page, likely blocked'}"
                )
                continue
            try:
                out[key] = json.loads(html.unescape(match.group(1)))
            except json.JSONDecodeError:
                out[key] = UpstreamError("Reddit returned a page that is not JSON")
        return out

    def _one(self, url: str) -> Any:
        value = self._fetch_json([url]).get(url)
        if value is None:
            raise UpstreamError("no result returned for Reddit request")
        if isinstance(value, Exception):
            raise value
        return value

    def search(self, query: str, subreddit: str | None = None, time_range: str = "year", limit: int = 5) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("query must not be empty")
        subreddit = _check_subreddit(subreddit)
        limit = max(1, min(int(limit), MAX_LISTING))
        params = {"q": query, "sort": "relevance", "t": _check_time_range(time_range), "limit": limit, "type": "link", "raw_json": 1}
        if subreddit:
            params["restrict_sr"] = 1
            url = f"https://www.reddit.com/r/{subreddit}/search.json?{urlencode(params)}"
        else:
            url = f"https://www.reddit.com/search.json?{urlencode(params)}"
        data = self._one(url)
        threads = [
            _post_summary(child.get("data") or {})
            for child in (data.get("data") or {}).get("children") or []
            if not (child.get("data") or {}).get("over_18")
        ]
        return {"query": query, "subreddit": subreddit, "time_range": time_range, "threads": threads[:limit]}

    def thread(self, url: str, max_comments: int = 20) -> dict[str, Any]:
        subreddit, thread_id = _thread_path(url)
        max_comments = max(1, min(int(max_comments), MAX_COMMENTS))
        return self._threads([(subreddit, thread_id)], max_comments)[0]

    def _thread_json_url(self, subreddit: str, thread_id: str, max_comments: int) -> str:
        params = {"sort": "top", "limit": max_comments * 2, "depth": MAX_DEPTH, "raw_json": 1}
        return f"https://www.reddit.com/r/{subreddit}/comments/{thread_id}/.json?{urlencode(params)}"

    def _threads(self, ids: list[tuple[str, str]], max_comments: int) -> list[dict[str, Any]]:
        urls = [self._thread_json_url(sub, tid, max_comments) for sub, tid in ids]
        fetched = self._fetch_json(urls)
        out: list[dict[str, Any]] = []
        for (sub, tid), url in zip(ids, urls):
            value = fetched.get(url)
            if value is None or isinstance(value, Exception):
                out.append({"id": tid, "subreddit": sub, "error": str(value or "no result returned")})
                continue
            post_data = value[0]["data"]["children"][0]["data"]
            comments, omitted = _flatten_comments(value[1]["data"]["children"], max_comments, post_data.get("author"))
            post = _post_summary(post_data)
            post["body"] = _clip(post_data.get("selftext") or "", MAX_POST_CHARS)
            out.append({"post": post, "comments": comments, "comments_omitted": omitted})
        return out

    def digest(self, query: str, subreddit: str | None = None, time_range: str = "year", max_threads: int = 3) -> dict[str, Any]:
        max_threads = max(1, min(int(max_threads), MAX_THREADS))
        found = self.search(query, subreddit=subreddit, time_range=time_range, limit=max_threads * 3)
        chosen = [t for t in found["threads"] if (t.get("num_comments") or 0) > 0][:max_threads]
        threads = self._threads([(t["subreddit"], t["id"]) for t in chosen], MAX_COMMENTS // max_threads) if chosen else []
        return {
            "query": found["query"],
            "subreddit": found["subreddit"],
            "time_range": time_range,
            "threads": threads,
            "not_opened": [
                {"title": t["title"], "score": t["score"], "permalink": t["permalink"]}
                for t in found["threads"] if t not in chosen
            ][:5],
            "summary_format": SUMMARY_FORMAT,
        }

    def subreddit_top(self, subreddit: str, time_range: str = "week", limit: int = 10) -> dict[str, Any]:
        name = _check_subreddit(subreddit)
        if not name:
            raise ValueError("subreddit is required")
        limit = max(1, min(int(limit), MAX_LISTING))
        params = {"t": _check_time_range(time_range), "limit": limit, "raw_json": 1}
        data = self._one(f"https://www.reddit.com/r/{name}/top.json?{urlencode(params)}")
        posts = [
            _post_summary(child.get("data") or {})
            for child in (data.get("data") or {}).get("children") or []
            if not (child.get("data") or {}).get("over_18")
        ]
        return {"subreddit": name, "time_range": time_range, "posts": posts}
