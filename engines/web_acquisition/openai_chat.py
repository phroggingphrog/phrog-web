"""Authenticated OpenAI-compatible routes for the conversational Web Agent.

The routes expose only the real OmniRoute combo catalog and a text chat protocol. There is one
execution path: ``web_chat.stream_chat``. Streaming adapts its application events to SSE, while
non-streaming consumes the same events into one completion object.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from .web_chat import WebChatError, available_models, stream_chat

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
_ALLOWED_ROLES = {"system", "developer", "user", "assistant"}


class _BadRequest(ValueError):
    def __init__(self, message: str, code: str = "invalid_request") -> None:
        super().__init__(message)
        self.code = code


def _error(message: str, error_type: str, code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": error_type, "code": code}}, status_code=status)


def _authorized(request: Request, token: Callable[[], str]) -> bool:
    supplied = request.headers.get("authorization", "")
    return secrets.compare_digest(supplied, f"Bearer {token()}")


def _safe_error(exc: BaseException) -> str:
    text = " ".join(str(exc).split())[:300]
    text = re.sub(r"(?i)bearer\s+\S+", "Bearer [redacted]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[redacted]", text)
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _message_text(item: dict[str, Any], index: int) -> str:
    content = item.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        if content is None and item.get("role") == "assistant":
            return ""
        raise _BadRequest(f"messages[{index}].content must be text or a list of text parts", "unsupported_content")
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "text" or not isinstance(part.get("text"), str):
            raise _BadRequest(
                f"messages[{index}] contains a non-text content part; this text web-research endpoint does not accept attachments",
                "unsupported_content",
            )
        parts.append(part["text"])
    return "".join(parts)


def _normalize_messages(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise _BadRequest("messages must be a nonempty array", "invalid_messages")
    normalized: list[dict[str, str]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise _BadRequest(f"messages[{index}] must be an object", "invalid_messages")
        role = item.get("role")
        if role not in _ALLOWED_ROLES:
            raise _BadRequest(
                f"messages[{index}].role {role!r} is not supported; supported roles are system, developer, user, assistant",
                "unsupported_role",
            )
        if any(key in item for key in ("tool_calls", "function_call", "tool_call_id")):
            raise _BadRequest(
                f"messages[{index}] carries client tool/function data; this endpoint does not implement function calling",
                "unsupported_tools",
            )
        text = _message_text(item, index)
        if role == "assistant" and not text.strip():
            continue  # empty historical assistant placeholder
        normalized.append({"role": "system" if role == "developer" else str(role), "content": text})
    if not any(message["role"] == "user" and message["content"].strip() for message in normalized):
        raise _BadRequest("messages must contain a nonempty user turn", "invalid_messages")
    return normalized


def _validate(body: Any) -> tuple[str, list[dict[str, str]], bool]:
    if not isinstance(body, dict):
        raise _BadRequest("request body must be a JSON object", "invalid_request")
    model = body.get("model")
    if not isinstance(model, str) or not model.strip():
        raise _BadRequest("model must be a nonempty string", "invalid_model")
    if "messages" not in body:
        raise _BadRequest("messages are required", "invalid_messages")
    stream = body.get("stream", False)
    if "stream" in body and not isinstance(stream, bool):
        raise _BadRequest("stream must be a boolean", "invalid_stream")
    if body.get("tools") or body.get("functions"):
        raise _BadRequest(
            "client tool definitions are not supported by this text web-research endpoint", "unsupported_tools"
        )
    if body.get("tool_choice") is not None or body.get("function_call") is not None:
        raise _BadRequest(
            "client tool selection is not supported by this text web-research endpoint", "unsupported_tools"
        )
    return model.strip(), _normalize_messages(body.get("messages")), stream


def _combo_ids(models: list[dict[str, Any]]) -> set[str]:
    return {record["id"] for record in models if isinstance(record.get("id"), str)}


async def _catalog() -> list[dict[str, Any]]:
    return await available_models()


def _chunk(completion_id: str, created: int, model: str, delta: dict[str, Any], finish_reason: str | None = None) -> dict[str, Any]:
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def _sse(payload: dict[str, Any]) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n\n"


def _text_chunks(text: str, size: int = 4000) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


async def _stream_response(messages: list[dict[str, str]], model: str) -> StreamingResponse:
    completion_id = f"chatcmpl-{uuid.uuid4()}"
    created = int(time.time())
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=64)
    finished = asyncio.Event()

    async def produce() -> None:
        source = stream_chat(messages, model)
        iterator = source.__aiter__()
        pending: asyncio.Task[Any] | None = None
        answered = False
        try:
            while True:
                pending = asyncio.create_task(anext(iterator))
                while True:
                    try:
                        event = await asyncio.wait_for(asyncio.shield(pending), timeout=10.0)
                    except asyncio.TimeoutError:
                        # Keep the graph's pending next-event operation alive while Cloudflare and
                        # provider body timers see traffic.
                        await queue.put({"type": "heartbeat"})
                        continue
                    break
                pending = None
                if event.get("type") == "answer":
                    answered = True
                await queue.put(event)
        except StopAsyncIteration:
            if not answered:
                with suppress(Exception):
                    await queue.put({"type": "error", "message": "the agent completed without producing an answer"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            with suppress(Exception):
                await queue.put({"type": "error", "message": _safe_error(exc)})
        finally:
            if pending is not None:
                pending.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await pending
            with suppress(asyncio.CancelledError, Exception):
                await source.aclose()
            finished.set()

    async def events():
        task = asyncio.create_task(produce())
        try:
            yield _sse(_chunk(completion_id, created, model, {"role": "assistant", "content": ""}))
            failed = False
            getter = asyncio.create_task(queue.get())
            finisher = asyncio.create_task(finished.wait())
            try:
                while True:
                    if getter.done():
                        item = getter.result()
                        getter = asyncio.create_task(queue.get())
                    else:
                        if finished.is_set() and queue.empty():
                            break
                        await asyncio.wait({getter, finisher}, return_when=asyncio.FIRST_COMPLETED)
                        if getter.done():
                            item = getter.result()
                            getter = asyncio.create_task(queue.get())
                        elif finished.is_set() and queue.empty():
                            break
                        else:
                            item = await getter
                            getter = asyncio.create_task(queue.get())
                    kind = item.get("type") if isinstance(item, dict) else None
                    if kind == "heartbeat":
                        yield ": keep-alive\n\n"
                    elif kind == "progress":
                        text = item.get("text")
                        if isinstance(text, str) and text:
                            yield _sse(_chunk(completion_id, created, model, {"reasoning_content": text}))
                    elif kind == "answer":
                        text = item.get("text")
                        if isinstance(text, str) and text:
                            for piece in _text_chunks(text):
                                yield _sse(_chunk(completion_id, created, model, {"content": piece}))
                    elif kind == "error":
                        message = item.get("message") if isinstance(item, dict) else None
                        yield _sse(
                            {
                                "error": {
                                    "message": str(message or "the agent run failed"),
                                    "type": "server_error",
                                    "code": "agent_error",
                                }
                            }
                        )
                        failed = True
                        break
            finally:
                getter.cancel()
                finisher.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await getter
                with suppress(asyncio.CancelledError, Exception):
                    await finisher
            if not failed:
                yield _sse(_chunk(completion_id, created, model, {}, "stop"))
                yield "data: [DONE]\n\n"
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await task

    return StreamingResponse(events(), media_type="text/event-stream", headers=_SSE_HEADERS)


async def _completion_response(messages: list[dict[str, str]], model: str) -> JSONResponse:
    answers: list[str] = []
    try:
        async for event in stream_chat(messages, model):
            if event.get("type") == "answer" and isinstance(event.get("text"), str):
                answers.append(event["text"])
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        return _error(_safe_error(exc), "server_error", "agent_error", 502)
    answer = "".join(answers)
    if not answer.strip():
        return _error("the agent completed without producing an answer", "server_error", "agent_error", 502)
    return JSONResponse(
        {
            "id": f"chatcmpl-{uuid.uuid4()}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}],
        }
    )


def routes(token: Callable[[], str]) -> list[Route]:
    """Build the authenticated OpenAI-compatible routes for the existing A2A app."""

    async def models(request: Request) -> JSONResponse:
        if not _authorized(request, token):
            return _error("Unauthorized", "authentication_error", "unauthorized", 401)
        try:
            catalog = await _catalog()
        except WebChatError as exc:
            return _error(str(exc), "upstream_error", "model_discovery_failed", 502)
        except Exception as exc:
            return _error(_safe_error(exc), "upstream_error", "model_discovery_failed", 502)
        return JSONResponse({"object": "list", "data": catalog})

    async def chat_completions(request: Request) -> JSONResponse | StreamingResponse:
        if not _authorized(request, token):
            return _error("Unauthorized", "authentication_error", "unauthorized", 401)
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError):
            return _error("request body must be valid JSON", "invalid_request_error", "invalid_json", 400)
        try:
            model, messages, stream = _validate(body)
        except _BadRequest as exc:
            return _error(str(exc), "invalid_request_error", exc.code, 400)
        try:
            catalog = await _catalog()
        except WebChatError as exc:
            return _error(str(exc), "upstream_error", "model_discovery_failed", 502)
        except Exception as exc:
            return _error(_safe_error(exc), "upstream_error", "model_discovery_failed", 502)
        if model not in _combo_ids(catalog):
            return _error(
                f"model {model!r} is not an available OmniRoute combo", "invalid_request_error", "unknown_model", 400
            )
        try:
            if stream:
                return await _stream_response(messages, model)
            return await _completion_response(messages, model)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return _error(_safe_error(exc), "server_error", "agent_error", 502)

    return [
        Route("/v1/models", models, methods=["GET"]),
        Route("/v1/chat/completions", chat_completions, methods=["POST"]),
    ]
