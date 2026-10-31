"""Authenticated loopback-only delivery of complete CNN captures to the local site."""
from __future__ import annotations

import hashlib
import http.cookiejar
import json
import secrets
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit, urljoin
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request, build_opener


class SiteError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class SameOriginRedirects(HTTPRedirectHandler):
    def __init__(self, base_url):
        self.origin = urlsplit(base_url)[:2]

    def redirect_request(self, request, response, code, message, headers, new_url):
        resolved = urljoin(request.full_url, new_url)
        if urlsplit(resolved)[:2] != self.origin:
            raise SiteError("本机工作台返回了外部跳转，已停止同步")
        return super().redirect_request(request, response, code, message, headers, resolved)


class LocalSite:
    def __init__(self, base_url: str = "http://127.0.0.1:5317"):
        url = urlsplit(base_url)
        if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
                or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment):
            raise ValueError("回传工作台必须是本机 HTTP 地址")
        self.base_url = base_url.rstrip("/")
        self.opener = build_opener(ProxyHandler({}), SameOriginRedirects(self.base_url),
                                   HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.signed_in = False

    def _login(self):
        # Use the existing local development sign-in flow; never invent auth headers.
        address = self.base_url + "/signin-with-chatgpt?" + urlencode({"return_to": "/api/status"})
        try:
            with self.opener.open(address, timeout=5) as response:
                data = json.load(response)
            if data.get("storage") != "local":
                raise SiteError("接收器仅允许连接本机工作台")
        except HTTPError as exc:
            raise SiteError("本机工作台登录未完成", exc.code) from exc
        self.signed_in = True

    def request(self, path: str, data: bytes | None = None, content_type: str = "application/json"):
        if not path.startswith("/api/") or path.startswith("//"):
            raise ValueError("只允许工作台 API 路径")
        if not self.signed_in:
            self._login()
        for attempt in range(2):
            request = Request(self.base_url + path, data=data, headers={
                "Origin": self.base_url, "Content-Type": content_type,
                "Accept": "application/json",
            })
            try:
                with self.opener.open(request, timeout=10) as response:
                    return json.load(response)
            except HTTPError as exc:
                if exc.code == 401 and attempt == 0:
                    self.signed_in = False
                    self._login()
                    continue
                try:
                    message = json.loads(exc.read(4096)).get("error", "工作台操作未完成")
                except (ValueError, AttributeError):
                    message = "工作台操作未完成"
                raise SiteError(str(message), exc.code) from exc
        raise SiteError("工作台登录失效")

    def status(self, status: dict):
        return self.request("/api/fpga/status", json.dumps(status, ensure_ascii=False).encode("utf-8"))

    def capture(self, metadata: dict, images: dict[str, bytes], quality: dict | None = None):
        required = {"result"} if metadata.get("captureKind") == "paired-display" else {"original", "result", "edges"}
        if set(images) != required:
            raise ValueError("图片集合与检测记录类型不一致")
        if any(not image or len(image) > 5 * 1024 * 1024 for image in images.values()):
            raise ValueError("图片为空或超过5MB")
        metadata = dict(metadata)
        metadata["sha256"] = {name: hashlib.sha256(image).hexdigest() for name, image in images.items()}
        boundary = "FPGA" + secrets.token_hex(24)
        parts = []
        def field(name: str, value: bytes, filename: str | None = None):
            disposition = f'Content-Disposition: form-data; name="{name}"'
            if filename:
                disposition += f'; filename="{filename}"'
            header = f"--{boundary}\r\n{disposition}\r\n"
            if filename:
                header += "Content-Type: image/png\r\n"
            parts.append(header.encode("ascii") + b"\r\n" + value + b"\r\n")
        field("metadata", json.dumps(metadata, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        if quality is not None:
            field("quality", json.dumps(quality, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        for name, image in images.items():
            field(name, image, name + ".png")
        parts.append(f"--{boundary}--\r\n".encode("ascii"))
        body = b"".join(parts)
        if len(body) > 16 * 1024 * 1024:
            raise ValueError("完整检测记录超过16MB")
        return self.request("/api/fpga/captures", body, f"multipart/form-data; boundary={boundary}")


def atomic_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    with temp.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.flush()
        import os
        os.fsync(stream.fileno())
    temp.replace(path)
