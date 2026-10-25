"""MCP bridge to the Hermes `webagent` profile A2A endpoint (Hermes VM, since 2026-10-05; was ZeroClaw).

One tool, ``research(question)``: POST an A2A ``message/send`` to the agent that
runs in the Hermes VM on phrogvps, so the searching, crawling and reading happen there and the
caller only sees the answer. No ``contextId`` is ever sent, so each call is a
fresh one-shot run: the agent has no memory of the previous question.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import anyio
from mcp.server.fastmcp import FastMCP

DEFAULT_URL = "http://127.0.0.1:42619/"  # web-agent-a2a.service (Deep Agents), loopback, token-gated
DEFAULT_TOKEN_FILE = "~/.config/web-agent-deep/a2a-token"
DEFAULT_TIMEOUT_S = 1800.0  # deep research (Feynman skills) can run long
# The agent turn costs a search plus reads; a runaway prompt buys nothing.
MAX_QUESTION_CHARS = 2000


class WebAgentError(RuntimeError):
    """The web agent could not be reached, or refused/failed the task."""


def _text_of(node: Any) -> str:
    """Join the non-empty ``text`` parts of an A2A message or artifact."""
    if not isinstance(node, dict):
        return ""
    return "\n".join(
        part["text"].strip()
        for part in node.get("parts") or []
        if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip()
    )


def _reply_text(payload: Any) -> str:
    """Extract the answer from a task: artifacts first, then the status message."""
    result = payload.get("result") if isinstance(payload, dict) else None
    if isinstance(result, dict) and isinstance(result.get("task"), dict):
        result = result["task"]  # wrapped SendMessageResponse (A2A v1.0 final)
    if not isinstance(result, dict):
        return ""
    for artifact in result.get("artifacts") or []:
        text = _text_of(artifact)
        if text:
            return text
    status = result.get("status")
    text = _text_of(status.get("message") if isinstance(status, dict) else None)
    return text or _text_of(result)


class WebAgentClient:
    """A2A client for one agent alias. Stateless: one task per call."""

    def __init__(
        self,
        url: str | None = None,
        token: str | None = None,
        token_file: str | None = None,
        timeout_s: float | None = None,
    ) -> None:
        self.url = url or os.getenv("WEB_AGENT_A2A_URL", DEFAULT_URL)
        self.timeout_s = float(os.getenv("WEB_AGENT_TIMEOUT_S", DEFAULT_TIMEOUT_S)) if timeout_s is None else timeout_s
        self._token = token
        self._token_file = token_file or os.getenv("WEB_AGENT_TOKEN_FILE", DEFAULT_TOKEN_FILE)

    @property
    def token(self) -> str:
        """The bearer token, read from the token file on first use."""
        if self._token is None:
            try:
                self._token = Path(self._token_file).expanduser().read_text().strip()
            except OSError as exc:
                raise WebAgentError(f"could not read the A2A token from {self._token_file}: {exc}") from exc
            if not self._token:
                raise WebAgentError(f"the A2A token file {self._token_file} is empty")
        return self._token

    def ask(self, question: str, max_chars: int = MAX_QUESTION_CHARS) -> dict[str, str]:
        """Run one research task. Returns answer, context_id and task_id.

        ``max_chars`` caps the question; the batch path raises it so a single
        instruction can carry several URLs. ``research`` keeps the default.
        """
        question = (question or "").strip()
        if not question:
            raise WebAgentError("question is empty")
        if len(question) > max_chars:
            raise WebAgentError(f"question is longer than {max_chars} characters")
        body = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "message/send",
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "ROLE_USER",
                    "parts": [{"kind": "text", "text": question}],
                }
            },
        }
        request = urllib.request.Request(
            self.url,
            data=json.dumps(body).encode(),
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            raise WebAgentError(f"the web agent returned HTTP {exc.code}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise WebAgentError(f"the web agent call failed: {exc}") from exc
        error = payload.get("error") if isinstance(payload, dict) else None
        if error:
            message = error.get("message", error) if isinstance(error, dict) else error
            raise WebAgentError(f"the web agent refused the task: {message}")
        answer = _reply_text(payload)
        if not answer:
            raise WebAgentError("the web agent returned no answer text")
        result = payload.get("result") if isinstance(payload, dict) else None
        if isinstance(result, dict) and isinstance(result.get("task"), dict):
            result = result["task"]
        result = result if isinstance(result, dict) else {}
        return {
            "answer": answer,
            "context_id": str(result.get("contextId") or ""),
            "task_id": str(result.get("id") or ""),
        }


mcp = FastMCP(
    "web-agent",
    instructions=(
        "Use research(question, mode='web') for a quick cited answer through the existing Vane backend. "
        "Use deep_research_start/status for long, staged Feynman research. The extract and social modes "
        "remain available through the web agent. For many known URLs with the same extraction per page, "
        "use parse_pages to batch the reads."
    ),
)
_client = WebAgentClient()


@mcp.tool()
async def research(question: str, mode: str = "web") -> dict[str, Any]:
    """Answer a quick web question through Vane, or use the web agent's extract/social modes.

    mode: web (default, short cited answer through Vane) | extract (read URLs, return the requested
    fields as JSON) | social (Reddit, Lemmy, Mastodon, YouTube). Use deep_research_start for a long report.
    """
    if mode == "web":
        from web_acquisition import vane

        return await vane.research(question)
    if mode not in {"extract", "social"}:
        raise ValueError("mode must be web, extract, or social")
    from web_acquisition import deep_agent  # heavy imports only when used

    return await anyio.to_thread.run_sync(lambda: deep_agent.ask(question, mode))


@mcp.tool()
async def extract(urls: list[str], schema: dict, instructions: str = "") -> dict:
    """Read URLs and return JSON that validates against `schema` (JSON Schema), like Firecrawl extract.

    Re-asks the model up to twice with the validation errors. `valid` says whether the final data passed;
    missing facts come back as null, never invented. `sources` lists the pages actually read.
    """
    from web_acquisition import extract as extract_mod

    return await anyio.to_thread.run_sync(lambda: extract_mod.extract_structured(urls, schema, instructions))


@mcp.tool()
async def save_to_wiki(
    kind: str = "note",
    urls: list[str] | None = None,
    text: str = "",
    question: str = "",
    title: str = "",
    target: str = "",
    job_id: str = "",
) -> dict:
    """Save gathered web material or a completed Feynman research job to the owner's LLM wiki inbox.

    kind: "note" (knowledge page: summary, key points, details, gaps, related, sources). Study plans are
    not made here: a planner agent calls this tool for the compiled material and plans from it.
    For new material, give urls (read for you), text (research already gathered), or a question (researched first).
    For a completed deep-research job, give its job_id to file the original cited report without rewriting it.
    Provide either job_id or urls/text/question. The file lands in ~/brain/wiki/inbox/ as a proposal.
    """
    from web_acquisition import wiki

    if job_id.strip():
        if urls or text.strip() or question.strip():
            raise ValueError("provide job_id or urls/text/question, not both")

        def save_job_report() -> dict[str, Any]:
            from web_acquisition import sitecrawl

            job = sitecrawl.job_status(job_id.strip())
            if job.get("kind") != "deep":
                raise ValueError(f"job '{job_id}' is not a deep-research job")
            if job.get("status") != "completed":
                raise ValueError(f"deep-research job '{job_id}' is {job.get('status', 'unknown')}; wait for completion first")
            if job.get("research_status") not in {"done", "blocked"}:
                raise ValueError(f"deep-research job '{job_id}' has no completed report")
            origin = job.get("path")
            if not isinstance(origin, str) or not Path(origin).is_file():
                raise ValueError(f"deep-research job '{job_id}' has no readable report file")
            report = Path(origin).read_text(errors="replace")
            if not report.strip():
                raise ValueError(f"deep-research job '{job_id}' produced an empty report")
            page_title = title.strip() or Path(origin).stem.replace("-", " ").replace("_", " ").title()
            return wiki.file_deliverable(page_title, report, origin, target)

        return await anyio.to_thread.run_sync(save_job_report)

    return await anyio.to_thread.run_sync(
        lambda: wiki.compile_to_wiki(kind=kind, urls=urls, text=text, question=question, title=title, target=target)
    )


@mcp.tool()
async def parse_pages(urls: list[str], task: str, chunk_size: int = 4, concurrency: int = 3) -> dict:
    """Extract the same thing from many known URLs, in one batched run.

    Use this when you already have a list of URLs (not a question) and want the
    same extraction applied to every page — e.g. headlines, prices or a summary.
    The URLs are split into small chunks and the agent crawls each chunk once;
    the full results are always saved as JSONL to a file on the VPS, and a
    possibly truncated copy is returned inline. Prefer ``research`` when you
    need to find the URLs first.
    """
    from web_acquisition.web_agent_batch import run_batch  # local import avoids an import cycle

    return await run_batch(urls, task, client=_client, chunk_size=chunk_size, concurrency=concurrency)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
