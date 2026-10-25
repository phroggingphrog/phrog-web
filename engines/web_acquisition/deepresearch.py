"""Slow, deep research: delegate to the host's Feynman MCP (127.0.0.1:8910) and wait for the cited deliverable.

Feynman keeps its own one-run-at-a-time lock and returns a job id when a run takes longer than ~4 minutes; this module
polls it until done (runs take 3-30 minutes). It is meant to run as a background job inside the web-agent service.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable

FEYNMAN_URL = os.getenv("WEB_AGENT_FEYNMAN_URL", "http://127.0.0.1:8910/mcp")
WORKFLOWS = ("deepresearch", "lit", "compare", "review", "audit", "summarize", "recipe", "draft")
MAX_TOTAL_S = 12 * 60 * 60


class DeepResearchError(RuntimeError):
    pass


async def _call(tool: str, args: dict[str, Any]) -> str:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(FEYNMAN_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            res = await session.call_tool(tool, args, read_timeout_seconds=timedelta(seconds=320))
            return "".join(getattr(c, "text", "") for c in res.content)


def _field(text: str, name: str) -> str | None:
    m = re.search(rf"(?m)^{name}: (.+)$", text)
    return m.group(1).strip() if m else None


def run_deep(workflow: str, topic: str, progress: Callable[..., None] | None = None,
             resume_job_id: str | None = None, resume_run_id: str | None = None,
             profile: str | None = None, tier: str | None = None, budget_usd: float | None = None,
             register: str | None = None, inference_depth: str | None = None, domain_notes: str | None = None) -> dict[str, Any]:
    if workflow not in WORKFLOWS:
        raise DeepResearchError(f"workflow must be one of {', '.join(WORKFLOWS)}")
    started = time.time()

    def note(msg: str, fid: str | None = None) -> None:
        if progress:
            progress(msg, fid)

    try:
        if resume_run_id:
            note("resuming the Feynman run from its saved checkpoint", resume_run_id)
            text = asyncio.run(_call("feynman_resume", {"runId": resume_run_id}))
        elif resume_job_id:  # a restarted service re-attaches to the Feynman run it had already started
            note("re-attached to the running Feynman job", resume_job_id)
            text = asyncio.run(_call("feynman_result", {"job_id": resume_job_id}))
        else:
            args: dict[str, Any] = {"workflow": workflow, "topic": topic}
            if profile:
                args["profile"] = profile
            if tier and tier != "pending":
                args["tier"] = tier
            if budget_usd is not None:
                args["budgetUsd"] = budget_usd
            if register:
                args["register"] = register
            if inference_depth:
                args["inferenceDepth"] = inference_depth
            if domain_notes:
                args["domainNotes"] = domain_notes
            text = asyncio.run(_call("feynman_research", args))
            while _field(text, "STATUS") == "busy" and time.time() - started < MAX_TOTAL_S:  # someone else's run holds the slot
                note("Feynman is busy with another run; retrying in 30 s")
                time.sleep(30)
                text = asyncio.run(_call("feynman_research", args))
        while _field(text, "STATUS") == "running" and time.time() - started < MAX_TOTAL_S:
            note(f"running {round(time.time() - started)}s, latest file {_field(text, 'LATEST_FILE')}", _field(text, "JOB_ID"))
            text = asyncio.run(_call("feynman_result", {"job_id": _field(text, "JOB_ID") or resume_job_id or ""}))
    except Exception as exc:  # connection refused, protocol error, ...
        raise DeepResearchError(f"Feynman MCP at {FEYNMAN_URL} failed: {type(exc).__name__}: {str(exc)[:200]}") from exc
    status = _field(text, "STATUS")
    if status not in {"done", "blocked"}:
        raise DeepResearchError(f"Feynman ended with status {status}: {(_field(text, 'ERROR') or text[:300])}")
    path = _field(text, "PATH")
    body = Path(path).read_text(errors="replace") if path and Path(path).is_file() else ""
    if not body:
        raise DeepResearchError("Feynman finished but no deliverable file was found")
    return {"status": status, "workflow": workflow, "run_id": _field(text, "RUN_ID"), "path": path, "seconds": round(time.time() - started),
            "chars": len(body), "deliverable": body}
