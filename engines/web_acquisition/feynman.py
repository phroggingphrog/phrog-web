"""Calls to the Feynman-owned research vault through its native MCP API."""

from __future__ import annotations

import json
import os
from datetime import timedelta
from typing import Any

DEFAULT_URL = "http://127.0.0.1:8910/mcp"


class FeynmanMcpError(RuntimeError):
    """Feynman's MCP service could not complete a vault operation."""


async def call(tool: str, arguments: dict[str, Any]) -> Any:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    url = os.getenv("WEB_AGENT_FEYNMAN_URL", DEFAULT_URL)
    try:
        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool, arguments, read_timeout_seconds=timedelta(seconds=90))
    except Exception as exc:
        raise FeynmanMcpError(f"Feynman MCP at {url} failed: {type(exc).__name__}: {str(exc)[:200]}") from exc
    text = "\n".join(getattr(item, "text", "") for item in result.content).strip()
    if getattr(result, "isError", False):
        raise FeynmanMcpError(text or f"Feynman tool {tool} failed")
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text
