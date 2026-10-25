"""Turn web research into wiki pages: read sources -> LLM formats them -> one file in ~/brain/wiki/inbox/.

Brain rule 1: agents propose into inbox/ (frontmatter source/date/target); the owner approves them
into place. One kind: ``note`` (a compiled knowledge page). Planning/curricula belong to a separate planner agent that
calls this one for the compiled material.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from . import deep_agent
from .extract import _read
from .service import WebAcquisitionService

INBOX = Path(os.getenv("WEB_AGENT_WIKI_INBOX", "~/brain/wiki/inbox")).expanduser()
MAX_INPUT_CHARS = 70000

COMMON = (
    "Write ONE markdown wiki page body for an LLM-maintained personal wiki. No frontmatter, no code fence around the "
    "page. Use only the SOURCE material; if it does not cover something, say so instead of filling from general "
    "knowledge. Put the source URL next to the claim it supports. Keep it under ~180 lines, headings with ## ."
)
PROMPTS = {
    "note": COMMON + (
        "\nStructure: a one-paragraph **Summary**; **Key points** (bullets); **Details** (organised by topic, with "
        "tables where they help); **Open questions / gaps**; **Related** (at least 2 [[wikilinks]] to likely wiki "
        "pages, kebab-case); **Sources** (numbered, URL + what it was used for)."
    ),
}


def _slug(text: str) -> str:
    return (re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "untitled")[:60]


def _title(body: str, fallback: str) -> str:
    m = re.search(r"(?m)^#\s+(.+)$", body)
    return (m.group(1) if m else fallback).strip()[:120]


def compile_to_wiki(*, kind: str = "note", urls: list[str] | None = None, text: str = "",
                    question: str = "", title: str = "", target: str = "") -> dict[str, Any]:
    if kind not in PROMPTS:
        raise deep_agent.DeepAgentError(f"kind must be one of {sorted(PROMPTS)}")
    if not (urls or text.strip() or question.strip()):
        raise deep_agent.DeepAgentError("give urls, text, or a question to research")
    service = WebAcquisitionService()
    parts: list[tuple[str, str]] = []
    for r in (_read(service, urls) if urls else []):
        if r.get("success"):
            parts.append((r["url"], r.get("markdown") or ""))
    if text.strip():
        parts.append(("owner-supplied text", text.strip()))
    if question.strip() and not parts:
        parts.append(("web research answer", deep_agent.ask(question.strip(), "web")["answer"]))
    if not parts:
        raise deep_agent.DeepAgentError("none of the URLs could be read and no text was given")
    per = MAX_INPUT_CHARS // len(parts)
    material = "\n\n".join(f"## SOURCE {i + 1}: {u}\n{c[:per]}" for i, (u, c) in enumerate(parts))
    truncated = any(len(c) > per for _, c in parts)

    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(model=deep_agent.MODEL, base_url=deep_agent.BASE_URL, api_key=deep_agent._api_key(), timeout=180)
    brief = f"Topic / request: {title or question or 'see sources'}\n\n{material}"
    reply = model.invoke([("system", PROMPTS[kind]), ("user", brief)]).content
    body = (reply if isinstance(reply, str) else "".join(p.get("text", "") for p in reply if isinstance(p, dict))).strip()
    body = re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", body)
    if len(body) < 200:
        raise deep_agent.DeepAgentError("the model returned no usable page")

    page_title = title or _title(body, question or "Web research")
    today = date.today().isoformat()
    default_target = "personal-learning/"
    sources = [u for u, _ in parts]
    front = (
        "---\n"
        f"title: {page_title}\n"
        "type: note\n"
        "source: web-agent\n"
        f"date: {today}\n"
        f"target: {target or default_target + _slug(page_title) + '.md'}\n"
        f"sources: [{', '.join(sources)}]\n"
        f"fetched: {datetime.now().isoformat(timespec='seconds')}\n"
        f"sha256: {hashlib.sha256(material.encode()).hexdigest()[:16]}\n"
        "status: proposed\n"
        "---\n\n"
    )
    INBOX.mkdir(parents=True, exist_ok=True)
    path = INBOX / f"{today}-web-agent-{_slug(page_title)}.md"
    n = 2
    while path.exists():
        path = INBOX / f"{today}-web-agent-{_slug(page_title)}-{n}.md"
        n += 1
    path.write_text(front + body + "\n")
    return {"path": str(path), "title": page_title, "kind": kind, "bytes": path.stat().st_size,
            "sources": sources, "truncated": truncated, "status": "proposed in wiki/inbox, awaiting owner approval"}


def file_deliverable(title: str, body: str, origin: str, target: str = "") -> dict[str, Any]:
    """Put an already-written, cited deliverable (e.g. from Feynman) into the wiki inbox as a proposal."""
    today = date.today().isoformat()
    page_target = target or "personal-learning/" + _slug(title) + ".md"
    front = (
        "---\n"
        f"title: {json.dumps(title)}\n"
        "type: note\n"
        "source: web-agent (feynman)\n"
        f"date: {today}\n"
        f"target: {json.dumps(page_target)}\n"
        f"sources: [{json.dumps(origin)}]\n"
        "status: proposed\n"
        "---\n\n"
    )
    INBOX.mkdir(parents=True, exist_ok=True)
    path, n = INBOX / f"{today}-web-agent-{_slug(title)}.md", 2
    while path.exists():
        path, n = INBOX / f"{today}-web-agent-{_slug(title)}-{n}.md", n + 1
    path.write_text(front + body.strip() + "\n")
    return {"inbox_path": str(path), "status": "proposed in wiki/inbox, awaiting owner approval"}
