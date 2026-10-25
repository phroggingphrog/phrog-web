"""Goal-driven browsing with Jev (browser-use/jev-ultrafast) in a dedicated headless Chromium.

A decision model (TypeSafe's Jev via OpenRouter by default; or TypeSafe direct, Codiv's OpenJev: set TYPESAFE_BASE_URL) picks each operation and
element; the text model for typed values is the OmniRoute deepseek-flash combo. Page text and the element table are sent to the
decision endpoint on every step. The browser is a separate throwaway profile (jev-chrome.service): never the owner's browser.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

JEV_DIR = Path(os.getenv("JEV_DIR", "~/apps/jev-ultrafast")).expanduser()
RUNNER = Path(__file__).resolve().parents[2] / "scripts" / "jev_run.py"


class BrowseError(RuntimeError):
    pass


def browse(url: str, goal: str, max_seconds: int = 90, max_chars: int = 6000) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        raise BrowseError("url must start with http:// or https://")
    if not goal.strip() or len(goal) > 2000:
        raise BrowseError("goal must be 1-2000 characters")
    # Default endpoint: OpenRouter's /api/v1/systemone serving TypeSafe's Jev (model jev-latest). Override with
    # TYPESAFE_BASE_URL / TYPESAFE_MODEL / TYPESAFE_API_KEY for TypeSafe direct, Codiv or a self-hosted OpenJev.
    key = (os.getenv("TYPESAFE_API_KEY") or os.getenv("OPENROUTER_API_KEY") or "").strip()
    if not key:
        raise BrowseError("browse needs a Jev decision key: set OPENROUTER_API_KEY (default endpoint) or TYPESAFE_API_KEY "
                          "in ~/.config/self-hosted-web-mcp.env, then restart the web-agent service")
    from . import deep_agent

    env = {
        **os.environ,
        "BU_CDP_URL": os.getenv("BU_CDP_URL", "http://127.0.0.1:9222"),
        "BH_TELEMETRY": "0", "BROWSER_HARNESS_TELEMETRY": "0", "ANONYMIZED_TELEMETRY": "0",
        "TYPESAFE_API_KEY": key,
        "TYPESAFE_BASE_URL": os.getenv("TYPESAFE_BASE_URL") or "https://openrouter.ai/api",
        "TYPESAFE_MODEL": os.getenv("TYPESAFE_MODEL") or "jev-latest",
        "TEXT_MODEL_BASE_URL": os.getenv("WEB_AGENT_LLM_BASE_URL", "http://127.0.0.1:20128/v1"),
        "TEXT_MODEL": deep_agent.MODEL,
        "TEXT_MODEL_API_KEY": deep_agent._api_key(),
        "TEXT_MODEL_REASONING": "none",
    }
    try:
        proc = subprocess.run(
            [str(JEV_DIR / ".venv/bin/python"), str(RUNNER)], input=json.dumps(
                {"url": url, "goal": goal, "max_seconds": max_seconds, "max_chars": max_chars}),
            capture_output=True, text=True, timeout=max_seconds + 60, env=env, cwd=str(JEV_DIR))
    except subprocess.TimeoutExpired as exc:
        raise BrowseError(f"browse did not finish within {max_seconds + 60}s") from exc
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
    if not lines:
        raise BrowseError(f"Jev runner produced no result (exit {proc.returncode}): {proc.stderr[-300:]}")
    result = json.loads(lines[-1])
    if not result.get("ok"):
        raise BrowseError(result.get("error", "unknown Jev error"))
    return result
