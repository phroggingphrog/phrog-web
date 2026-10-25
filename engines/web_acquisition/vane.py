"""Short cited answers through the existing Vane Perplexity-style MCP backend."""

from __future__ import annotations

import json
import os
from datetime import timedelta
from typing import Any

DEFAULT_URL = "http://127.0.0.1:8931/mcp"
TIMEOUT_S = float(os.getenv("VANE_MCP_TIMEOUT_S", "300"))


class VaneError(RuntimeError):
    """Vane could not return a short web answer."""


async def research(question: str) -> dict[str, Any]:
    """Ask Vane for a quick, cited answer; this never starts a deep-research run."""
    question = (question or "").strip()
    if not question:
        raise VaneError("question is empty")

    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    url = os.getenv("VANE_MCP_URL", DEFAULT_URL)
    try:
        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "web_research",
                    {
                        "question": question,
                        "depth": "quick",
                        "sources": ["web"],
                        "instructions": "Give a concise answer for a quick lookup. Cite factual claims with the returned sources and state clearly if the sources do not establish the answer.",
                    },
                    read_timeout_seconds=timedelta(seconds=TIMEOUT_S),
                )
    except Exception as exc:
        raise VaneError(f"Vane MCP at {url} failed: {type(exc).__name__}: {str(exc)[:200]}") from exc

    text = "\n".join(getattr(item, "text", "") for item in result.content).strip()
    if getattr(result, "isError", False):
        raise VaneError(text or "Vane returned an error")
    if not text:
        raise VaneError("Vane returned no answer")
    try:
        answer = json.loads(text)
    except json.JSONDecodeError:
        return {"answer": text, "citations": [], "gaps": ["The Vane response was not structured; source citations could not be extracted."]}
    if not isinstance(answer, dict) or not isinstance(answer.get("answer"), str) or not answer["answer"].strip():
        raise VaneError("Vane returned an empty or malformed answer")
    return answer
