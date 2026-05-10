"""文件用途：X/Twitter cookie 凭证的本地存取。"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .providers import XAuthenticationError, XCookieAuth, load_x_cookie_auth_from_env

DEFAULT_CACHE_SUBDIR = "tradex"
DEFAULT_AUTH_FILENAME = "x_auth.json"


def default_x_auth_store_path() -> Path:
    """说明：返回默认 X auth 本地存储路径。"""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / DEFAULT_CACHE_SUBDIR / DEFAULT_AUTH_FILENAME


@dataclass(frozen=True)
class XAuthStatus:
    """说明：X auth 存储状态，不包含明文 secret。"""

    has_saved_auth: bool
    saved_at_ms: int | None
    path: Path
    env_available: bool

    def to_payload(self) -> dict[str, Any]:
        return {
            "hasSavedAuth": self.has_saved_auth,
            "savedAtMs": self.saved_at_ms,
            "envAvailable": self.env_available,
        }


class XAuthStore:
    """说明：用权限收紧的本地 JSON 文件保存 X cookie。"""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path).expanduser() if path is not None else default_x_auth_store_path()

    def status(self) -> XAuthStatus:
        saved_at_ms: int | None = None
        if self.path.exists():
            try:
                payload = self._read_payload()
                raw_saved_at = payload.get("saved_at_ms")
                saved_at_ms = int(raw_saved_at) if raw_saved_at is not None else None
            except Exception:
                saved_at_ms = None
        return XAuthStatus(
            has_saved_auth=self.path.exists(),
            saved_at_ms=saved_at_ms,
            path=self.path,
            env_available=bool(os.environ.get("TWITTER_AUTH_TOKEN") and os.environ.get("TWITTER_CT0")),
        )

    def save(self, *, auth_token: str, ct0: str) -> XAuthStatus:
        token = auth_token.strip()
        csrf = ct0.strip()
        if not token or not csrf:
            raise ValueError("auth_token and ct0 are required")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "auth_token": token,
            "ct0": csrf,
            "saved_at_ms": int(time.time() * 1000),
        }
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        temp_path = self.path.with_name(f".{self.path.name}.tmp")
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.path)
            self.path.chmod(0o600)
        except Exception:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass
            raise
        return self.status()

    def clear(self) -> XAuthStatus:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        return self.status()

    def load(self) -> XCookieAuth:
        """优先读取本地保存的 cookie，缺失时回退环境变量。"""
        if self.path.exists():
            payload = self._read_payload()
            auth_token = str(payload.get("auth_token") or "").strip()
            ct0 = str(payload.get("ct0") or "").strip()
            if auth_token and ct0:
                return XCookieAuth(auth_token=auth_token, ct0=ct0)
            raise XAuthenticationError("saved X auth is incomplete", status_code=401)
        return load_x_cookie_auth_from_env()

    def _read_payload(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise XAuthenticationError("saved X auth cannot be read", status_code=401) from exc
        if not isinstance(payload, dict):
            raise XAuthenticationError("saved X auth has invalid format", status_code=401)
        return payload
