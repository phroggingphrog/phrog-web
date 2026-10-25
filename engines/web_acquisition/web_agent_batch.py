"""Batch "parse many web pages" path for the web-agent A2A bridge.

``run_batch`` splits known URLs into small chunks, asks the ZeroClaw web agent to
crawl each chunk once (one ``web_crawl`` call per chunk) and applies the same
task to every page. Results are aligned to the input order and written as JSONL
on the VPS, so a long batch survives even when the reply is too large to return
inline.

The batch question is bigger than the one-question research cap, so it is sent
with an explicit ``max_chars``; ``research`` keeps the 2000-character default.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from typing import Any, Sequence

import anyio

from web_acquisition.web_agent_server import WebAgentClient, WebAgentError

DEFAULT_OUT_DIR = "~/data/web-agent/batches"
# One chunk carries up to six URLs plus the task; six thousand characters is
# enough for that while staying well below a runaway prompt.
BATCH_QUESTION_CHARS = 6000
# Keep the MCP reply small; the full set is always on disk.
INLINE_LIMIT = 8000
MAX_URLS = 60
# Per-page crawl cap = the service maximum (WEB_MCP_MAX_MARKDOWN_CHARS, 50000). Owner 2026-09-30: "remove compression";
# the agent tool-result budget (max_tool_result_chars) was raised to 400000 to fit a 6-URL chunk. Earlier: at the 12000-char default, three or more pages overflow the agent's
# tool-result budget and it reports every page after the first as truncated.
PAGE_CHARS = 50000
MAX_TASK_CHARS = 1500
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def build_chunk_question(urls: list[str], task: str, page_chars: int = PAGE_CHARS) -> str:
    """Build the self-contained instruction for one chunk of URLs.

    It pins the crawl to exactly these URLs, forbids ``web_search``, caps each
    page so the combined crawl result is not truncated before the agent reads
    it, and fixes the reply shape so ``parse_answer`` can align it back.
    """
    return (
        f"Call the web_acquisition web_crawl tool exactly ONCE with max_chars={page_chars} and this list of URLs "
        "(JSON array, same order):\n"
        f"{json.dumps(urls)}\n"
        "Do not call web_search and do not add, remove, reorder or skip any URL.\n"
        f"Task to apply to every page: {task}\n"
        "Blocked, empty or failed pages must be reported, not dropped.\n"
        'Reply with ONLY a JSON array, one object per URL in the same order as the input:\n'
        '[{"url": "<url>", "ok": true, "data": <result for the task>, "error": null}]\n'
        "Use ok=false and a short error string for any page that could not be read. "
        "No prose, no markdown fences, nothing outside the JSON array."
    )


def _extract_json_array(answer: str) -> list | None:
    """Return the first JSON array in ``answer``, tolerating fences and prose."""
    text = (answer or "").strip()
    candidates = [match.group(1).strip() for match in _FENCE_RE.finditer(text)]
    candidates.append(text)
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, list):
            return parsed
    return None


def parse_answer(answer: str, urls: list[str]) -> list[dict]:
    """Align the agent's reply to ``urls``, one result per input URL in order.

    Missing URLs become ``ok=false``. A reply with no parseable JSON array marks
    every URL failed and keeps the first 500 characters for debugging.
    """
    parsed = _extract_json_array(answer)
    if parsed is None:
        raw = (answer or "")[:500]
        return [{"url": url, "ok": False, "data": None, "error": "unparseable reply", "raw": raw} for url in urls]
    by_url: dict[str, dict] = {}
    for entry in parsed:
        if isinstance(entry, dict) and isinstance(entry.get("url"), str):
            by_url.setdefault(entry["url"].strip(), entry)
    # The agent sometimes normalises a URL (trailing slash, redirect target); when the reply has one
    # entry per input URL, fall back to position.
    positional = len(parsed) == len(urls) and all(isinstance(entry, dict) for entry in parsed)
    results: list[dict] = []
    for index, url in enumerate(urls):
        entry = by_url.get(url) or (parsed[index] if positional else None)
        if entry is None:
            results.append({"url": url, "ok": False, "data": None, "error": "missing from agent reply"})
            continue
        results.append(
            {"url": url, "ok": bool(entry.get("ok")), "data": entry.get("data"), "error": entry.get("error")}
        )
    return results


def _prepare_urls(urls: Sequence[str]) -> list[str]:
    """Validate schemes, deduplicate keeping order, and enforce the 1–60 range."""
    seen: list[str] = []
    for raw in urls:
        url = (raw or "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError(f"not an http/https URL: {url!r}")
        if url not in seen:
            seen.append(url)
    if not seen:
        raise ValueError("at least one URL is required")
    if len(seen) > MAX_URLS:
        raise ValueError(f"too many URLs: {len(seen)} (maximum {MAX_URLS})")
    return seen


def _validate_task(task: str) -> str:
    """Check the task is present and fits the agent prompt budget."""
    task = (task or "").strip()
    if not task:
        raise ValueError("task is empty")
    if len(task) > MAX_TASK_CHARS:
        raise ValueError(f"task is longer than {MAX_TASK_CHARS} characters")
    return task


def _slug(text: str) -> str:
    """A short filesystem-safe slug, at most 40 characters."""
    return _SLUG_RE.sub("-", text.lower()).strip("-")[:40] or "batch"


def _default_out_path(task: str) -> Path:
    """``<UTC stamp>-<task slug>.jsonl`` under the batch data directory."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path(DEFAULT_OUT_DIR).expanduser() / f"{stamp}-{_slug(task)}.jsonl"


def _write_jsonl(path: Path, results: list[dict]) -> None:
    """Write one result per line, creating parents and restricting mode to 0600."""
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for item in results:
            handle.write(json.dumps(item, ensure_ascii=False, default=str) + "\n")
    os.chmod(path, 0o600)


def _inline_results(results: list[dict]) -> list[dict]:
    """The longest prefix of ``results`` whose JSON stays within INLINE_LIMIT."""
    fitted: list[dict] = []
    for item in results:
        if len(json.dumps(fitted + [item], default=str)) > INLINE_LIMIT:
            break
        fitted.append(item)
    return fitted


def _answer_text(reply: Any) -> str:
    """Accept the client's dict reply, or a bare string from a simple client."""
    if isinstance(reply, dict):
        return str(reply.get("answer") or "")
    return str(reply or "")


async def run_batch(
    urls: Sequence[str],
    task: str,
    *,
    client: Any = None,
    chunk_size: int = 4,
    concurrency: int = 3,
    out_path: str | os.PathLike[str] | None = None,
) -> dict:
    """Parse many known URLs, one chunk at a time, and persist every result.

    Chunks run concurrently (bounded by ``concurrency``) with the client call in
    a worker thread. A chunk whose ``ask`` raises ``WebAgentError`` fails only
    its own URLs; the other chunks finish. JSONL always lands on disk and the
    inline ``results`` are truncated past ``INLINE_LIMIT``.
    """
    prepared = _prepare_urls(urls)
    task = _validate_task(task)
    if not 1 <= chunk_size <= 6:
        raise ValueError("chunk_size must be between 1 and 6")
    if not 1 <= concurrency <= 4:
        raise ValueError("concurrency must be between 1 and 4")
    client = client if client is not None else WebAgentClient()
    chunks = [prepared[i : i + chunk_size] for i in range(0, len(prepared), chunk_size)]
    gathered: list[list[dict] | None] = [None] * len(chunks)
    limiter = anyio.CapacityLimiter(concurrency)

    async def _run_chunk(index: int, chunk: list[str]) -> None:
        async with limiter:
            question = build_chunk_question(chunk, task)
            try:
                reply = await anyio.to_thread.run_sync(partial(client.ask, question, max_chars=BATCH_QUESTION_CHARS))
            except WebAgentError as exc:
                gathered[index] = [{"url": url, "ok": False, "data": None, "error": str(exc)} for url in chunk]
                return
            gathered[index] = parse_answer(_answer_text(reply), chunk)

    async with anyio.create_task_group() as task_group:
        for index, chunk in enumerate(chunks):
            task_group.start_soon(_run_chunk, index, chunk)

    results = [item for group in gathered for item in (group or [])]
    ok = sum(1 for item in results if item["ok"])
    target = Path(out_path).expanduser() if out_path is not None else _default_out_path(task)
    _write_jsonl(target, results)
    inline = _inline_results(results)
    summary = {
        "count": len(results),
        "ok": ok,
        "failed": len(results) - ok,
        "out_path": str(target),
        "results": inline,
    }
    if len(inline) < len(results):
        summary["truncated"] = True
    return summary


def _load_urls(urls_file: str) -> list[str]:
    """Read URLs, one per line, skipping blanks and ``#`` comments. ``-`` is stdin."""
    if urls_file == "-":
        lines = sys.stdin.read().splitlines()
    else:
        lines = Path(urls_file).expanduser().read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="webagent-batch", description="Parse many known URLs with the web agent.")
    parser.add_argument("--task", required=True, help="what to extract from every page")
    parser.add_argument("--urls-file", help="file with one URL per line ('#' comments allowed); '-' reads stdin")
    parser.add_argument("--out", help="JSONL output path (default: a timestamped file on the VPS)")
    parser.add_argument("--chunk", type=int, default=4, help="URLs per agent call (1-6)")
    parser.add_argument("--concurrency", type=int, default=3, help="chunks in flight (1-4)")
    parser.add_argument("urls", nargs="*", help="URLs (or use --urls-file / '-' for stdin)")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    """CLI entry point: print the summary JSON, exit 0 if any page succeeded."""
    args = _parser().parse_args(argv)
    urls = list(args.urls)
    if "-" in urls:
        urls = [url for url in urls if url != "-"] + _load_urls("-")
    if args.urls_file:
        urls.extend(_load_urls(args.urls_file))
    try:
        summary = anyio.run(
            partial(
                run_batch,
                urls,
                args.task,
                chunk_size=args.chunk,
                concurrency=args.concurrency,
                out_path=args.out,
            )
        )
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(2) from exc
    print(json.dumps({key: summary[key] for key in ("count", "ok", "failed", "out_path")}))
    raise SystemExit(0 if summary["ok"] else 1)


if __name__ == "__main__":
    main()
