"""OpenAI Chat Completions provider，支持任意 OpenAI 兼容端点。"""
from __future__ import annotations

import json
import os
from typing import Any

import httpx

from ...config import AgentConfig
from ...config.agent_models import AgentModelProfile
from ..loop import ChatResponse, ToolCall
from ..provider import LLMProviderError, LLMProviderUnavailable

OPENAI_CHAT_PROVIDER = "openai"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENAI_ENV_API_KEYS = ("TERMINAL_TICKER_OPENAI_API_KEY", "OPENAI_API_KEY")


class OpenAIChatProvider:
    """通过 OpenAI Chat Completions API 完成 agent loop 推理的 provider。"""

    name = OPENAI_CHAT_PROVIDER

    def __init__(self, config: AgentConfig, profile: AgentModelProfile | None = None) -> None:
        self.config = config
        self.model = config.model
        self._base_url = os.getenv(
            "TERMINAL_TICKER_OPENAI_BASE_URL",
            os.getenv("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL),
        ).rstrip("/")

    async def analyze(self, context: dict[str, Any]) -> Any:
        """兼容旧的 analyze 接口（无 tool calling）。"""
        from ..provider import AGENT_INSTRUCTIONS, _result_from_text

        messages = [
            {"role": "system", "content": AGENT_INSTRUCTIONS},
            {"role": "user", "content": json.dumps(context, ensure_ascii=False, separators=(",", ":"))},
        ]
        try:
            response = await self.chat(messages)
            text = response.content or ""
            if not text:
                from ..provider import AgentAnalysisResult
                return AgentAnalysisResult.unavailable(
                    provider=self.name, model=self.model,
                    error="OpenAI returned no output text.",
                )
            return _result_from_text(text, provider=self.name, model=self.model)
        except Exception as exc:
            from ..provider import AgentAnalysisResult
            return AgentAnalysisResult.unavailable(
                provider=self.name, model=self.model,
                error=str(exc) or exc.__class__.__name__,
            )

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ChatResponse:
        """调用 OpenAI Chat Completions API，支持 tool calling。"""
        api_key = _resolve_openai_api_key()
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self._base_url}/chat/completions",
                json=payload,
                headers=headers,
            )

        if response.status_code >= 400:
            raise LLMProviderError(_openai_error_message(response.status_code, response.text))

        data = response.json()
        return _parse_chat_response(data)

    async def list_models(self) -> list[dict[str, Any]]:
        """列出可用模型。"""
        api_key = _resolve_openai_api_key()
        headers = {"Authorization": f"Bearer {api_key}"}
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{self._base_url}/models", headers=headers)
        if response.status_code >= 400:
            raise LLMProviderError(_openai_error_message(response.status_code, response.text))
        data = response.json()
        models = data.get("data", [])
        return [
            {
                "slug": m.get("id", ""),
                "displayName": m.get("id", ""),
                "description": "",
                "visibility": "public",
                "supportedInApi": True,
                "defaultReasoningEffort": "",
                "supportedReasoningEfforts": [],
                "contextWindow": None,
                "preferWebsockets": False,
            }
            for m in models
            if isinstance(m, dict)
        ]


def _resolve_openai_api_key() -> str:
    for env_name in OPENAI_ENV_API_KEYS:
        value = os.getenv(env_name, "").strip()
        if value:
            return value
    raise LLMProviderUnavailable(
        "No OpenAI API key found. Set TERMINAL_TICKER_OPENAI_API_KEY or OPENAI_API_KEY."
    )


def _openai_error_message(status_code: int, body: str) -> str:
    detail = ""
    try:
        payload = json.loads(body)
        if isinstance(payload, dict):
            err = payload.get("error")
            if isinstance(err, dict):
                detail = str(err.get("message", err))
            elif isinstance(err, str):
                detail = err
    except json.JSONDecodeError:
        detail = body.strip()[:200]
    suffix = f": {detail}" if detail else ""
    return f"OpenAI request failed: HTTP {status_code}{suffix}"


def _parse_chat_response(data: dict[str, Any]) -> ChatResponse:
    choices = data.get("choices", [])
    if not choices:
        return ChatResponse(content="", finish_reason="stop")

    choice = choices[0]
    message = choice.get("message", {})
    finish_reason = choice.get("finish_reason", "stop")
    content = message.get("content")

    tool_calls: list[ToolCall] = []
    raw_tool_calls = message.get("tool_calls")
    if raw_tool_calls and isinstance(raw_tool_calls, list):
        for tc in raw_tool_calls:
            func = tc.get("function", {})
            try:
                args = json.loads(func.get("arguments", "{}"))
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(ToolCall(
                id=tc.get("id", ""),
                name=func.get("name", ""),
                arguments=args,
            ))

    usage = data.get("usage", {})
    usage_dict = {}
    if isinstance(usage, dict):
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            if isinstance(usage.get(key), int):
                usage_dict[key] = usage[key]

    return ChatResponse(
        content=content,
        tool_calls=tool_calls,
        finish_reason=finish_reason,
        usage=usage_dict,
    )
