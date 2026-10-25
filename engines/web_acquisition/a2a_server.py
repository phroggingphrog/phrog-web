"""A2A server for the Deep Agents web agent: other agents send a task, get a cited answer back.

JSON-RPC ``message/send`` (legacy parts ``{"kind":"text"}``) and ``SendMessage`` (parts ``{"text"}``) are both
accepted. Each call is a fresh one-shot run. Loopback bind and a bearer token; the agent card is public.
Pick a mode with ``params.metadata.mode`` = web | social | extract | wiki (default web).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import uuid
from pathlib import Path
from typing import Any

import anyio
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import deep_agent
from .openai_chat import routes as openai_routes

HOST = os.getenv("WEB_AGENT_A2A_HOST", "127.0.0.1")
PORT = int(os.getenv("WEB_AGENT_A2A_PORT", "42619"))
TOKEN_FILE = Path(os.getenv("WEB_AGENT_A2A_TOKEN_FILE", "~/.config/web-agent-deep/a2a-token")).expanduser()
MAX_CHARS = 4000

CARD = {
    "name": "web-agent",
    "description": "Self-hosted web research, parsing, extraction, crawling and social media research agent. "
                   "One-shot: no memory between calls, so send self-contained requests.",
    "version": "1.0.0",
    "protocolVersion": "0.3.0",
    "url": f"http://{HOST}:{PORT}/",
    "capabilities": {"streaming": False},
    "defaultInputModes": ["text/plain"],
    "defaultOutputModes": ["text/plain"],
    "skills": [
        {"id": "web", "name": "Web research", "description": "Search, read pages, answer with cited URLs.", "tags": ["research"]},
        {"id": "extract", "name": "Parse and extract", "description": "Read URLs and return the requested fields as JSON/markdown.", "tags": ["parser", "crawler"]},
        {"id": "browse", "name": "Browse", "description": "Goal-driven browsing in a headless browser (Jev). Needs a Jev decision endpoint key.", "tags": ["browser"]},
        {"id": "deep", "name": "Deep research", "description": "Slow (3-30 min) cited research via Feynman; returns a working task, poll tasks/get.", "tags": ["research"]},
        {"id": "wiki", "name": "Save to wiki", "description": "Parse URLs/research into a formatted wiki inbox page.", "tags": ["wiki"]},
        {"id": "social", "name": "Social research", "description": "Reddit, Lemmy, Mastodon, YouTube search and summary.", "tags": ["social"]},
    ],
    "security": [{"bearer": []}],
}


def _token() -> str:
    if not TOKEN_FILE.exists():
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        TOKEN_FILE.write_text(secrets.token_urlsafe(32))
        TOKEN_FILE.chmod(0o600)
    return TOKEN_FILE.read_text().strip()


def _text(message: dict[str, Any]) -> str:
    return "\n".join(
        p["text"].strip() for p in message.get("parts") or []
        if isinstance(p, dict) and isinstance(p.get("text"), str) and p["text"].strip()
    )


def _err(rid: Any, code: int, message: str, status: int = 200) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}, status_code=status)


async def card(_: Request) -> JSONResponse:
    return JSONResponse(CARD)


async def rpc(request: Request) -> JSONResponse:
    if not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {_token()}"):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except ValueError:
        return _err(None, -32700, "parse error", 400)
    rid = body.get("id") if isinstance(body, dict) else None
    if isinstance(body, dict) and body.get("method") in {"tasks/get", "GetTask"}:
        return await _get_task(rid, body.get("params") or {})
    if not isinstance(body, dict) or body.get("method") not in {"message/send", "SendMessage"}:
        return _err(rid, -32601, "supported methods: message/send, SendMessage, tasks/get")
    params = body.get("params") or {}
    message = params.get("message") or {}
    question = _text(message)
    if not question or len(question) > MAX_CHARS:
        return _err(rid, -32602, f"message text must be 1-{MAX_CHARS} characters")
    mode = str((params.get("metadata") or message.get("metadata") or {}).get("mode", "web"))
    modes = sorted({*deep_agent.MODES, "wiki", "deep", "browse"})
    if mode not in modes:
        return _err(rid, -32602, f"mode must be one of {modes}")
    task_id, context_id = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        if mode == "browse":  # goal-driven browsing with Jev; metadata.url (or the first URL in the text) is the start page
            from . import browse as browse_mod

            meta = params.get("metadata") or message.get("metadata") or {}
            found = re.findall(r"https?://[^\s)>\]]+", question)
            start = str(meta.get("url") or (found[0] if found else ""))
            res = await anyio.to_thread.run_sync(lambda: browse_mod.browse(start, question, int(meta.get("max_seconds", 90))))
            state, text = "completed", json.dumps({k: res[k] for k in ("status", "steps", "page")}, ensure_ascii=False)[:20000]
        elif mode == "deep":  # slow job: answer "working" now, the caller polls tasks/get with the returned task id
            from . import sitecrawl
            from .service import WebAcquisitionService

            meta = params.get("metadata") or message.get("metadata") or {}
            global _service
            _service = _service or WebAcquisitionService()
            job = await anyio.to_thread.run_sync(lambda: sitecrawl.start_job(_service, "deep", dict(
                topic=question, workflow=str(meta.get("workflow", "deepresearch")), to_wiki=bool(meta.get("to_wiki", False)),
                title=str(meta.get("title", "")))))
            return JSONResponse({"jsonrpc": "2.0", "id": rid, "result": {
                "kind": "task", "id": job["job_id"], "contextId": str(uuid.uuid4()),
                "status": {"state": "working", "message": {"role": "agent", "parts": [{"kind": "text",
                           "text": "Deep research started (3-30 min). Poll tasks/get with this task id."}]}}, "artifacts": []}})
        elif mode == "wiki":
            from . import wiki  # heavy imports only when used

            meta = params.get("metadata") or message.get("metadata") or {}
            urls = re.findall(r"https?://[^\s)>\]]+", question)
            saved = await anyio.to_thread.run_sync(lambda: wiki.compile_to_wiki(
                kind="note", urls=urls or None, text="" if urls else "",
                question=question, title=str(meta.get("title", "")), target=str(meta.get("target", ""))))
            state, text = "completed", f"Saved {saved['kind']} '{saved['title']}' to {saved['path']} ({saved['status']}). Sources: " + ", ".join(saved["sources"])
        else:
            out = await anyio.to_thread.run_sync(lambda: deep_agent.ask(question, mode))
            state, text = "completed", out["answer"]
    except (deep_agent.DeepAgentError, ValueError, RuntimeError) as exc:
        state, text = "failed", str(exc)
    task = {
        "kind": "task", "id": task_id, "contextId": context_id, "status": {"state": state},
        "artifacts": [{"artifactId": str(uuid.uuid4()), "name": "answer",
                       "parts": [{"kind": "text", "text": text}]}] if state == "completed" else [],
    }
    if state == "failed":
        task["status"]["message"] = {"role": "agent", "parts": [{"kind": "text", "text": text}]}
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "result": task})


_service = None


async def _get_task(rid: Any, params: dict[str, Any]) -> JSONResponse:
    from . import sitecrawl

    try:
        st = sitecrawl.job_status(str(params.get("id", "")), include_results=True, offset=0, limit=0)
    except ValueError:
        return _err(rid, -32602, "invalid task id")
    if st.get("status") == "unknown":
        return _err(rid, -32001, "task not found")
    state = {"running": "working", "completed": "completed", "failed": "failed"}.get(st["status"], "working")
    task: dict[str, Any] = {"kind": "task", "id": st["job_id"], "contextId": "", "status": {"state": state}, "artifacts": []}
    if state == "completed" and st.get("deliverable"):
        task["artifacts"] = [{"artifactId": st["job_id"], "name": "deliverable",
                              "parts": [{"kind": "text", "text": st["deliverable"]}]}]
    elif state == "failed":
        task["status"]["message"] = {"role": "agent", "parts": [{"kind": "text", "text": st.get("error") or "failed"}]}
    elif st.get("note"):
        task["status"]["message"] = {"role": "agent", "parts": [{"kind": "text", "text": st["note"]}]}
    return JSONResponse({"jsonrpc": "2.0", "id": rid, "result": task})


async def jobs(request: Request) -> JSONResponse:
    """Start a crawl/batch job inside this long-lived service so it outlives the caller's session."""
    global _service
    if not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {_token()}"):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
        kind, params = body["kind"], dict(body["params"])
        if kind not in {"crawl", "batch", "deep"}:
            raise ValueError("kind must be crawl, batch or deep")
    except (ValueError, KeyError, TypeError) as exc:
        return JSONResponse({"error": f"bad request: {exc}"}, status_code=400)
    from . import sitecrawl
    from .service import WebAcquisitionService

    _service = _service or WebAcquisitionService()
    try:
        return JSONResponse(await anyio.to_thread.run_sync(lambda: sitecrawl.start_job(_service, kind, params)))
    except (TypeError, ValueError) as exc:  # unknown parameter names, invalid URL
        return JSONResponse({"error": f"bad parameters: {exc}"}, status_code=400)


app = Starlette(routes=[
    Route("/jobs", jobs, methods=["POST"]),
    Route("/.well-known/agent-card.json", card),
    Route("/.well-known/agent.json", card),
    Route("/", rpc, methods=["POST"]),
    *openai_routes(_token),
])


def main() -> None:
    _token()
    from . import sitecrawl

    from .service import WebAcquisitionService

    global _service
    _service = WebAcquisitionService()
    print('job recovery:', sitecrawl.recover(_service), flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
