"""Plain HTTP fetching with IP pinning, plus document/HTML to markdown conversion.

A plain GET is much cheaper than a headless browser and is enough for most
articles, docs, and every PDF (which Chromium treats as a download). Each
connection - including every redirect hop - resolves the host once, rejects
non-public addresses, and connects to exactly that IP, so DNS rebinding cannot
steer a fetch to phrogvps's internal services. Through the egress proxy the
fetcher sends ``CONNECT <pinned-ip>:<port>``, never the hostname, and TLS still
verifies the certificate against the real hostname.
"""

from __future__ import annotations

import functools
import http.client
import io
import ipaddress
import re
import socket
import ssl
import urllib.request
import zlib
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlparse

BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
MAX_BODY_BYTES = 25 * 1024 * 1024

# Content types handed to MarkItDown, with the extension it uses to pick a converter.
DOCUMENT_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/epub+zip": ".epub",
}
TEXT_TYPES = {"text/plain", "text/markdown", "text/csv", "application/json"}
HTML_TYPES = {"text/html", "application/xhtml+xml"}


class FetchError(OSError):
    """A plain fetch failed (network, proxy, status, size, or unsupported type)."""


def public_ips(hostname: str, port: int, allow_private: bool) -> list[str]:
    hostname = hostname.rstrip(".")
    try:
        addresses = list(dict.fromkeys(info[4][0] for info in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)))
    except socket.gaierror as exc:
        raise ValueError(f"could not resolve URL host {hostname!r}") from exc
    if not allow_private:
        for address in addresses:
            ip = ipaddress.ip_address(address.split("%")[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                raise ValueError(f"private or non-public URL host is blocked: {hostname}")
    return addresses


def _pinned_socket(host: str, port: int, timeout: float | None, allow_private: bool, proxy: tuple[str, int] | None) -> socket.socket:
    try:
        ip = public_ips(host, port, allow_private)[0]
    except ValueError as exc:
        raise FetchError(str(exc)) from exc
    if proxy is None:
        return socket.create_connection((ip, port), timeout)
    sock = socket.create_connection(proxy, timeout)
    target = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
    sock.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    reply = b""
    while b"\r\n\r\n" not in reply and len(reply) < 65536:
        chunk = sock.recv(4096)
        if not chunk:
            break
        reply += chunk
    status = reply.split(b"\r\n", 1)[0]
    if not re.match(rb"HTTP/1\.[01] 200", status):
        sock.close()
        raise FetchError(f"egress proxy refused CONNECT: {status.decode('latin-1', 'replace')}")
    return sock


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args: Any, allow_private: bool = False, proxy: tuple[str, int] | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._allow_private, self._egress_proxy = allow_private, proxy

    def connect(self) -> None:
        self.sock = _pinned_socket(self.host, self.port, self.timeout, self._allow_private, self._egress_proxy)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args: Any, allow_private: bool = False, proxy: tuple[str, int] | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._allow_private, self._egress_proxy = allow_private, proxy

    def connect(self) -> None:
        sock = _pinned_socket(self.host, self.port, self.timeout, self._allow_private, self._egress_proxy)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, allow_private: bool, proxy: tuple[str, int] | None) -> None:
        super().__init__()
        self._factory = functools.partial(_PinnedHTTPConnection, allow_private=allow_private, proxy=proxy)

    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(self._factory, req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, allow_private: bool, proxy: tuple[str, int] | None) -> None:
        super().__init__(context=ssl.create_default_context())
        self._factory = functools.partial(_PinnedHTTPSConnection, allow_private=allow_private, proxy=proxy)

    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(self._factory, req, context=self._context)


def plain_get(
    url: str, timeout: float, allow_private: bool, proxy: tuple[str, int] | None, headers: dict[str, str] | None = None
) -> tuple[str, int, str, bytes]:
    """GET a URL; return (final_url, status, content_type, body). Redirect hops are pinned too."""
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),  # ignore *_proxy env vars; egress is chosen explicitly
        _PinnedHTTPHandler(allow_private, proxy),
        _PinnedHTTPSHandler(allow_private, proxy),
    )
    request = urllib.request.Request(url, headers=headers or {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_BODY_BYTES + 1)
            if len(body) > MAX_BODY_BYTES:
                raise FetchError(f"response larger than {MAX_BODY_BYTES // (1024 * 1024)} MB")
            if (response.headers.get("Content-Encoding") or "").lower() == "gzip":
                # Some APIs (StackExchange) gzip regardless of Accept-Encoding.
                # Cap the inflated size too, so a small bomb cannot exhaust memory.
                inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
                body = inflater.decompress(body, MAX_BODY_BYTES + 1)
                if len(body) > MAX_BODY_BYTES or inflater.unconsumed_tail:
                    raise FetchError(f"decompressed response larger than {MAX_BODY_BYTES // (1024 * 1024)} MB")
            content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            return response.geturl(), response.status, content_type, body
    except HTTPError as exc:
        raise FetchError(f"HTTP {exc.code}") from exc
    except (OSError, http.client.HTTPException) as exc:
        if isinstance(exc, FetchError):
            raise
        raise FetchError(f"{type(exc).__name__}: {exc}") from exc


@functools.lru_cache(maxsize=1)
def _markitdown() -> Any:
    from markitdown import MarkItDown

    return MarkItDown(enable_plugins=False)  # no third-party plugin code


def _clean_document_text(text: str) -> str:
    # arXiv and some publishers print a vertical sidebar that extracts as one
    # character per line (with the odd blank line). Drop runs of 8+ single-
    # character lines; numeric table columns ("0.95", "12") are left alone.
    text = re.sub(r"(?:^\S[ \t]*\n(?:[ \t]*\n)?){8,}", "", text, flags=re.M)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _document_extension(url: str, content_type: str) -> str | None:
    if content_type in DOCUMENT_TYPES:
        return DOCUMENT_TYPES[content_type]
    path = urlparse(url).path.lower()
    return next((ext for ext in DOCUMENT_TYPES.values() if path.endswith(ext)), None)


def convert(url: str, content_type: str, body: bytes) -> tuple[str, str, str]:
    """Return (markdown, title, converter) for a fetched body, or raise FetchError."""
    extension = _document_extension(url, content_type)
    if extension and content_type not in HTML_TYPES:
        from markitdown import StreamInfo

        try:
            result = _markitdown().convert_stream(io.BytesIO(body), stream_info=StreamInfo(mimetype=content_type or None, extension=extension, url=url))
        except Exception as exc:  # MarkItDown raises a variety of converter-specific errors
            raise FetchError(f"MarkItDown could not convert {extension}: {type(exc).__name__}") from exc
        return _clean_document_text(result.markdown or ""), str(getattr(result, "title", None) or ""), "markitdown"
    if content_type in HTML_TYPES or (not content_type and body.lstrip()[:1] == b"<"):
        import trafilatura

        page = body.decode("utf-8", "replace")
        markdown = trafilatura.extract(
            page, url=url, output_format="markdown", include_links=True, include_tables=True, favor_precision=True
        ) or ""
        match = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
        title = re.sub(r"\s+", " ", match.group(1)).strip() if match else ""
        return markdown.strip(), title, "trafilatura"
    if content_type in TEXT_TYPES or content_type.startswith("text/"):
        return body.decode("utf-8", "replace").strip(), "", "text"
    raise FetchError(f"unsupported content type {content_type or 'unknown'!r}")
