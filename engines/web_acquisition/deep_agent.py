"""One-shot web research agent built on LangChain Deep Agents.

Tools are the self-hosted ones (SearXNG search, plain/browser crawl, free research APIs). The model is an
OmniRoute combo; no provider client and no memory: every call builds a fresh agent.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .service import UpstreamError, WebAcquisitionService

BASE_URL = os.getenv("WEB_AGENT_LLM_BASE_URL", "http://127.0.0.1:20128/v1")
MODEL = os.getenv("WEB_AGENT_LLM_MODEL", "deepseek-flash")  # owner's OmniRoute combo
KEYS_ENV = Path("~/.config/llm-gateway/keys.env").expanduser()
RECURSION_LIMIT = int(os.getenv("WEB_AGENT_RECURSION_LIMIT", "40"))

SYSTEM_PROMPT = (
    "You are a web research agent. Use web_search to find sources, web_crawl to read the best 2-5 pages, "
    "and research_search for papers or technical Q&A. Answer from what you read, cite every claim with its "
    "URL, and say plainly when a page was blocked or you could not verify something. Public web only. If the "
    "question needs a full multi-source brief or literature review that you cannot finish in a few searches, call "
    "deep_research (slow Feynman job), do not wait for it, and put the returned job_id in your answer."
)


class DeepAgentError(RuntimeError):
    pass


def _api_key() -> str:
    key = os.getenv("OMNIROUTE_API_KEY")
    if key:
        return key
    try:
        for line in KEYS_ENV.read_text().splitlines():
            if line.startswith("OMNIROUTE_API_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError as exc:
        raise DeepAgentError(f"could not read the OmniRoute key from {KEYS_ENV}: {exc}") from exc
    raise DeepAgentError(f"OMNIROUTE_API_KEY not found in {KEYS_ENV}")


def _tools(service: WebAcquisitionService) -> list[Any]:
    def web_search(query: str, limit: int = 5, time_range: str | None = None) -> dict:
        """Search SearXNG. time_range: day|week|month|year."""
        return service.search(query, limit, time_range=time_range)

    def web_crawl(urls: list[str], max_chars: int = 12000) -> dict:
        """Fetch public URLs and return cleaned markdown (plain fetch, browser only when needed)."""
        try:
            return service.crawl(urls, max_chars, mode="auto")
        except UpstreamError as exc:
            service.accept_short = True  # browser crawler unreachable: take whatever plain fetch can read
            try:
                result = service.crawl(urls, max_chars, mode="plain")
            except (UpstreamError, ValueError) as plain_exc:
                return {"error": f"{exc}; plain: {plain_exc}"}
            result["note"] = "browser crawler unavailable; plain fetch only (JavaScript pages may be missing)"
            return result

    def research_search(query: str, preset: str = "academic", limit: int = 3) -> dict:
        """Free research APIs. preset: academic | tech | all."""
        return service.research(query, None, preset, limit, "stackoverflow")

    def deep_research(topic: str, workflow: str = "deepresearch") -> dict:
        """Hand a big question to Feynman (slow, 3-30 min, thorough cited brief). Returns a job id at once.

        Do NOT wait for it. Use only when the question needs a full multi-source brief or literature review that
        this quick run cannot give. workflow: deepresearch | lit | compare | summarize | review | audit | draft.
        Tell the caller the job_id so they can fetch the result with deep_research_status.
        """
        from . import sitecrawl

        return sitecrawl.start(service, "deep", dict(topic=topic, workflow=workflow, to_wiki=False, title=""))

    return [web_search, web_crawl, research_search, deep_research]


SOCIAL_PROMPT = (
    "You are a social media research agent. Use social_search (Reddit, Lemmy, Mastodon, YouTube) to find "
    "posts and threads, web_crawl to read the best ones, and summarise what people actually say: common "
    "views, disagreements, notable links. Quote briefly, cite every post URL, and state which platforms "
    "returned nothing. X, Instagram and TikTok are not available."
)


EXTRACT_PROMPT = (
    "You are a web parser/extractor. Use web_crawl to read the given URL(s) (follow links with more web_crawl "
    "calls only when the task needs them), then return ONLY what was asked: valid JSON when fields or a schema "
    "are given, otherwise concise markdown. Never invent values; use null and say why when a field is missing "
    "or the page was blocked."
)
MODES = {"web": SYSTEM_PROMPT, "social": SOCIAL_PROMPT, "extract": EXTRACT_PROMPT}


def _social_tool(service: WebAcquisitionService) -> Any:
    def social_search(query: str, platform: str = "all", limit: int = 8) -> dict:
        """Search social platforms. platform: all | reddit | lemmy | mastodon | youtube."""
        engines = {"all": "reddit,lemmy posts,lemmy comments,mastodon hashtags,youtube", "reddit": "reddit",
                   "lemmy": "lemmy posts,lemmy comments", "mastodon": "mastodon hashtags", "youtube": "youtube"}
        return service.search(query, limit, engines=engines.get(platform, engines["all"]))

    return social_search


def ask(question: str, mode: str = "web") -> dict[str, str]:
    from deepagents import create_deep_agent
    from langchain_openai import ChatOpenAI

    question = (question or "").strip()
    if not question:
        raise DeepAgentError("question is empty")
    model = ChatOpenAI(model=MODEL, base_url=BASE_URL, api_key=_api_key(), timeout=120)
    service = WebAcquisitionService()
    tools = _tools(service)
    if mode == "social":
        tools.append(_social_tool(service))
    agent = create_deep_agent(model=model, tools=tools,
                              system_prompt=MODES.get(mode, SYSTEM_PROMPT))
    try:
        state = agent.invoke(
            {"messages": [{"role": "user", "content": question}]},
            config={"recursion_limit": RECURSION_LIMIT},
        )
    except Exception as exc:  # surface a short, key-free reason
        raise DeepAgentError(f"deep agent run failed: {type(exc).__name__}: {str(exc)[:300]}") from exc
    content = state["messages"][-1].content
    if isinstance(content, list):
        content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not str(content).strip():
        raise DeepAgentError("deep agent returned no answer text")
    return {"answer": str(content).strip(), "context_id": "", "task_id": ""}
