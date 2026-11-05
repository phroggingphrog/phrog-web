"""phrog-web backend — native ``web_search`` / ``web_extract`` without MCP.

Set ``PHROG_WEB_URL`` (default ``http://127.0.0.1:8890``) and select it with::

    hermes config set web.search_backend phrog-web
    hermes config set web.extract_backend phrog-web

The phrog-web service owns every upstream key, so this plugin needs no credential of its own.
"""
from __future__ import annotations

from .provider import PhrogWebSearchProvider


def register(ctx) -> None:
    """Plugin entry point — called once at load time."""
    ctx.register_web_search_provider(PhrogWebSearchProvider())
