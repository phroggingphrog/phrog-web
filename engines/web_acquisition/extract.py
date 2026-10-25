"""Schema-validated extraction (Firecrawl "extract"): read URLs, return JSON that matches a JSON Schema."""

from __future__ import annotations

import json
import re
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from . import deep_agent
from .service import UpstreamError, WebAcquisitionService

MAX_INPUT_CHARS = 60000
RETRIES = 2


def _read(service: WebAcquisitionService, urls: list[str]) -> list[dict[str, Any]]:
    try:
        return service.crawl(urls, 20000, mode="auto")["results"]
    except UpstreamError:
        service.accept_short = True
        return service.crawl(urls, 20000, mode="plain")["results"]


def _json_from(text: str) -> Any:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    return json.loads(m.group(1) if m else text)


def extract_structured(urls: list[str], schema: dict[str, Any], instructions: str = "") -> dict[str, Any]:
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise deep_agent.DeepAgentError(f"schema is not valid JSON Schema: {exc.message}") from exc
    from langchain_openai import ChatOpenAI

    service = WebAcquisitionService()
    pages = [r for r in _read(service, urls) if r.get("success")]
    if not pages:
        raise deep_agent.DeepAgentError("none of the URLs could be read")
    per = MAX_INPUT_CHARS // len(pages)
    material = "\n\n".join(f"## SOURCE {r['url']}\nPage title: {r.get('title') or ''}\n{(r.get('markdown') or '')[:per]}" for r in pages)
    model = ChatOpenAI(model=deep_agent.MODEL, base_url=deep_agent.BASE_URL, api_key=deep_agent._api_key(), timeout=120)
    prompt = (
        "Extract data from the sources below. Reply with ONLY one JSON value that validates against this JSON Schema. "
        "Use null for anything the sources do not state; never invent values.\n"
        f"Schema:\n{json.dumps(schema)}\n{('Instructions: ' + instructions) if instructions else ''}\n\n{material}"
    )
    validator, errors, data = Draft202012Validator(schema), [], None
    messages: list[Any] = [("user", prompt)]
    for _ in range(RETRIES + 1):
        reply = model.invoke(messages).content
        reply = reply if isinstance(reply, str) else "".join(p.get("text", "") for p in reply if isinstance(p, dict))
        try:
            data = _json_from(reply)
            errors = sorted(f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in validator.iter_errors(data))
        except ValueError as exc:
            data, errors = None, [f"not valid JSON: {exc}"]
        if not errors:
            break
        messages += [("assistant", reply), ("user", "That did not validate:\n" + "\n".join(errors[:10]) + "\nReturn corrected JSON only.")]
    return {"data": data, "valid": not errors, "errors": errors[:10], "sources": [r["url"] for r in pages]}
