"""文件用途：Codex Agent provider，封装凭证、请求和模型发现。"""
from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

from ...config import AgentConfig
from ...config.agent_models import (
    AgentModelProfile,
    CODEX_API_MODE,
    CODEX_PROVIDER,
    DEFAULT_CODEX_BASE_URL,
    resolve_agent_model,
)
from ..provider import (
    AGENT_INSTRUCTIONS,
    AgentAnalysisResult,
    LLMProviderError,
    LLMProviderUnavailable,
    _result_from_text,
)

CODEX_ENV_API_KEYS = ("TERMINAL_TICKER_CODEX_API_KEY", "CODEX_API_KEY")


class CodexProvider:
    """说明：封装通过 Codex Responses 风格接口完成分析的 provider。"""

    name = CODEX_PROVIDER

    def __init__(self, config: AgentConfig, profile: AgentModelProfile | None = None) -> None:
        """说明：初始化当前对象的运行状态。"""
        self.config = config
        self.profile = profile or resolve_agent_model(config)
        if self.profile.api_mode != CODEX_API_MODE:
            raise LLMProviderUnavailable(f"Unsupported Codex api_mode: {self.profile.api_mode}")
        self.model = self.profile.model

    async def analyze(self, context: dict[str, Any]) -> AgentAnalysisResult:
        """说明：分析一个结构化行情上下文。"""
        try:
            credentials = _resolve_codex_credentials()
            response_data = await self._request_analysis(credentials, context)
            text = _extract_response_text(response_data)
            if not text:
                return AgentAnalysisResult.unavailable(
                    provider=self.name,
                    model=self.model,
                    error="Codex returned no output text.",
                )
            return _result_from_text(text, provider=self.name, model=self.model)
        except LLMProviderUnavailable as exc:
            return AgentAnalysisResult.unavailable(
                provider=self.name,
                model=self.model,
                error=str(exc),
            )
        except Exception as exc:
            return AgentAnalysisResult.unavailable(
                provider=self.name,
                model=self.model,
                error=str(exc) or exc.__class__.__name__,
            )

    async def _request_analysis(
        self,
        credentials: dict[str, str],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        """说明：调用 Codex Responses 风格的流式分析接口。"""
        api_root = DEFAULT_CODEX_BASE_URL.rstrip("/")
        payload: dict[str, Any] = {
            "model": self.model,
            "instructions": AGENT_INSTRUCTIONS,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
                        }
                    ],
                }
            ],
            "store": False,
            "stream": True,
            "reasoning": {
                "effort": self.profile.reasoning_effort,
                "summary": "auto",
            },
        }
        headers = {
            "Authorization": f"Bearer {credentials['api_key']}",
            "Content-Type": "application/json",
            **_codex_request_headers(credentials["api_key"], credentials.get("account_id")),
        }
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{api_root}/responses",
                json=payload,
                headers=headers,
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode(errors="replace")
                    raise LLMProviderError(_response_error_message(response.status_code, body))
                output_text = await _collect_response_stream_text(response)
        return {"output_text": output_text}

    async def list_models(self) -> list[dict[str, Any]]:
        """说明：拉取当前账号可见的 Codex 模型列表。"""
        credentials = _resolve_codex_credentials()
        api_root = DEFAULT_CODEX_BASE_URL.rstrip("/")
        headers = {
            "Authorization": f"Bearer {credentials['api_key']}",
            **_codex_request_headers(credentials["api_key"], credentials.get("account_id")),
        }
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                f"{api_root}/models",
                params={"client_version": "1.0.0"},
                headers=headers,
            )
        if response.status_code >= 400:
            raise LLMProviderError(_response_error_message(response.status_code, response.text))
        data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            raise LLMProviderError("Codex returned an invalid model list.")
        return [_codex_model_option(item) for item in data["models"] if isinstance(item, dict)]


async def _collect_response_stream_text(response: httpx.Response) -> str:
    """说明：收集响应流文本。"""
    chunks: list[str] = []
    done_text: str | None = None
    async for line in response.aiter_lines():
        if not line.startswith("data: "):
            continue
        raw_data = line.removeprefix("data: ").strip()
        if not raw_data or raw_data == "[DONE]":
            continue
        try:
            event = json.loads(raw_data)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str):
                chunks.append(delta)
        elif event_type == "response.output_text.done":
            text = event.get("text")
            if isinstance(text, str):
                done_text = text
        elif event_type in {"response.failed", "response.incomplete", "error"}:
            raise LLMProviderError(_event_error_message(event))
    text = "".join(chunks).strip()
    if text:
        return text
    return (done_text or "").strip()


def _response_error_message(status_code: int, body: str) -> str:
    """说明：生成不泄露凭证的 provider 错误信息。"""
    detail = ""
    try:
        payload = json.loads(body)
        if isinstance(payload, dict):
            raw_detail = payload.get("detail") or payload.get("error") or payload.get("message")
            if isinstance(raw_detail, dict):
                detail = str(raw_detail.get("message") or raw_detail)
            elif raw_detail is not None:
                detail = str(raw_detail)
    except json.JSONDecodeError:
        detail = body.strip()
    suffix = f": {detail.strip()}" if detail.strip() else ""
    return f"Codex request failed: HTTP {status_code}{suffix}"


def _event_error_message(event: dict[str, Any]) -> str:
    """说明：规范化 Responses 流式事件中的错误信息。"""
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("code") or error
        return f"Codex request failed: {message}"
    if isinstance(error, str):
        return f"Codex request failed: {error}"
    return f"Codex request failed: {event.get('type') or 'stream error'}"


def _codex_model_option(item: dict[str, Any]) -> dict[str, Any]:
    """说明：把 Codex 模型对象规范化成前端选项。"""
    levels = item.get("supported_reasoning_levels")
    reasoning_efforts: list[str] = []
    if isinstance(levels, list):
        for level in levels:
            if isinstance(level, dict) and isinstance(level.get("effort"), str):
                reasoning_efforts.append(level["effort"])
    return {
        "slug": str(item.get("slug") or ""),
        "displayName": str(item.get("display_name") or item.get("slug") or ""),
        "description": str(item.get("description") or ""),
        "visibility": str(item.get("visibility") or ""),
        "supportedInApi": bool(item.get("supported_in_api", True)),
        "defaultReasoningEffort": str(item.get("default_reasoning_level") or ""),
        "supportedReasoningEfforts": reasoning_efforts,
        "contextWindow": item.get("context_window") if isinstance(item.get("context_window"), int) else None,
        "preferWebsockets": bool(item.get("prefer_websockets", False)),
    }


def _resolve_codex_credentials() -> dict[str, str]:
    """说明：从环境变量或 Codex CLI 登录文件解析凭证。"""
    api_key = _first_env(CODEX_ENV_API_KEYS)
    if api_key:
        return {"api_key": api_key}

    codex = _read_codex_cli_credentials()
    if codex:
        return {
            "api_key": codex["api_key"],
            "account_id": codex.get("account_id", ""),
        }

    raise LLMProviderUnavailable(
        "No Codex credential found. Set TERMINAL_TICKER_CODEX_API_KEY "
        "or login with the Codex CLI so ~/.codex/auth.json contains valid tokens."
    )


def _first_env(names: tuple[str, ...]) -> str | None:
    """说明：返回第一项非空环境变量。"""
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def _codex_auth_path() -> Path:
    """说明：返回 Codex CLI 的 auth.json 路径。"""
    codex_home = os.getenv("CODEX_HOME", "").strip()
    if not codex_home:
        codex_home = str(Path.home() / ".codex")
    return Path(codex_home).expanduser() / "auth.json"


def _read_codex_cli_credentials() -> dict[str, str] | None:
    """说明：读取 Codex CLI 本地登录凭证。"""
    auth_path = _codex_auth_path()
    if not auth_path.is_file():
        return None
    try:
        payload = json.loads(auth_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None
    access_token = str(tokens.get("access_token") or "").strip()
    if not access_token:
        return None
    if _access_token_is_expiring(access_token, skew_seconds=0):
        raise LLMProviderUnavailable(
            "Codex CLI access token is expired. Run `codex` once to refresh the login."
        )
    account_id = str(tokens.get("account_id") or "").strip()
    if not account_id:
        claims = _jwt_claims(access_token)
        account_id = str(
            claims.get("chatgpt_account_id")
            or claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
            or ""
        ).strip()
    return {"api_key": access_token, "account_id": account_id}


def _access_token_is_expiring(access_token: str, *, skew_seconds: int) -> bool:
    """说明：判断 JWT access token 是否已经过期。"""
    claims = _jwt_claims(access_token)
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= time.time() + max(0, skew_seconds)


def _jwt_claims(token: str) -> dict[str, Any]:
    """说明：解析 JWT claims 供本地元数据使用。"""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return {}
    return claims if isinstance(claims, dict) else {}


def _codex_request_headers(access_token: str, account_id: str | None = None) -> dict[str, str]:
    """说明：构造 Codex CLI 风格的请求头。"""
    headers = {
        "User-Agent": "codex_cli_rs/0.0.0 (Terminal Ticker)",
        "originator": "codex_cli_rs",
    }
    if isinstance(account_id, str) and account_id.strip():
        headers["ChatGPT-Account-ID"] = account_id.strip()
        return headers
    claims = _jwt_claims(access_token)
    token_account_id = (
        claims.get("chatgpt_account_id")
        or claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")
    )
    if isinstance(token_account_id, str) and token_account_id:
        headers["ChatGPT-Account-ID"] = token_account_id
    return headers


def _extract_response_text(data: dict[str, Any]) -> str:
    """说明：从 Responses API 常见响应结构中提取文本。"""
    output_text = data.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()
    text_parts: list[str] = []
    output = data.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if isinstance(text, str):
                        text_parts.append(text)
    return "".join(text_parts).strip()

