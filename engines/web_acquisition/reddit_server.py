from __future__ import annotations

import anyio
from mcp.server.fastmcp import FastMCP

from .reddit import RedditDigestService

mcp = FastMCP(
    "reddit-digest",
    instructions=(
        "Bounded Reddit reading through the self-hosted homelab crawler. Use only when the user asks "
        "about Reddit or wants community opinions. Prefer reddit_digest: it returns a capped set of "
        "threads plus summary_format; follow that format and stop rather than opening more threads. "
        "Cite comments by their permalink."
    ),
)
_service = RedditDigestService()


@mcp.tool()
async def reddit_digest(query: str, subreddit: str | None = None, time_range: str = "year", max_threads: int = 3) -> dict:
    """Find the most relevant Reddit threads for a question and return their top comments, capped.

    max_threads is at most 5; comments are split across threads (30 total), top-level plus one reply level.
    time_range: hour|day|week|month|year|all.
    """
    return await anyio.to_thread.run_sync(lambda: _service.digest(query, subreddit, time_range, max_threads))


@mcp.tool()
async def reddit_search(query: str, subreddit: str | None = None, time_range: str = "year", limit: int = 5) -> dict:
    """Search Reddit posts (titles, scores, comment counts, permalinks) without opening them."""
    return await anyio.to_thread.run_sync(lambda: _service.search(query, subreddit, time_range, limit))


@mcp.tool()
async def reddit_thread(url: str, max_comments: int = 20) -> dict:
    """Read one Reddit thread: the post plus its top comments by score (at most 30, two levels deep)."""
    return await anyio.to_thread.run_sync(lambda: _service.thread(url, max_comments))


@mcp.tool()
async def reddit_subreddit_top(subreddit: str, time_range: str = "week", limit: int = 10) -> dict:
    """List a subreddit's top posts for a period (titles only, no comments) to skim without browsing."""
    return await anyio.to_thread.run_sync(lambda: _service.subreddit_top(subreddit, time_range, limit))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
