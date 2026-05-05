"""Anthropic Messages provider for the mytradebot analysis agent."""
from __future__ import annotations

import json
import os
from typing import Any

import httpx

from ...config import AgentConfig
from ...config.agent_models import (
    ANTHROPIC_MESSAGES_API_MODE,
    ANTHROPIC_PROVIDER,
    DEFAULT_ANTHROPIC_MODEL,
    AgentModelProfile,
    resolve_agent_model,
)
from ..loop import ChatResponse, ToolCall
from ..provider import (
    AGENT_INSTRUCTIONS,
    AgentAnalysisResult,
    LLMProviderError,
    LLMProviderUnavailable,
    _result_from_text,
)

DEFAULT_ANTHROPIC_BASE_URL = "https://claude-proxy.p1.cn/api"
ANTHROPIC_ENV_API_KEYS = (
    "MYTRADEBOT_ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
)
ANTHROPIC_ENV_BASE_URLS = ("MYTRADEBOT_ANTHROPIC_BASE_URL", "ANTHROPIC_BASE_URL")
ANTHROPIC_ENV_MODELS = ("MYTRADEBOT_ANTHROPIC_MODELS", "ANTHROPIC_MODELS")
ANTHROPIC_ENV_MAX_TOKENS = ("MYTRADEBOT_ANTHROPIC_MAX_TOKENS", "ANTHROPIC_MAX_TOKENS")


class AnthropicProvider:
    """通过 Anthropic Messages API 完成 agent loop 推理的 provider。"""

    name = ANTHROPIC_PROVIDER

    def __init__(self, config: AgentConfig, profile: AgentModelProfile | None = None) -> None:
        self.config = config
        self.profile = profile or resolve_agent_model(config)
        if self.profile.api_mode != ANTHROPIC_MESSAGES_API_MODE:
            raise LLMProviderUnavailable(
                f"Unsupported Anthropic api_mode: {self.profile.api_mode}"
            )
        self.model = self.profile.model
        self._base_url = _first_env(ANTHROPIC_ENV_BASE_URLS) or DEFAULT_ANTHROPIC_BASE_URL
        self._max_tokens = _resolve_max_tokens()

    async def analyze(self, context: dict[str, Any]) -> AgentAnalysisResult:
        """兼容旧的 analyze 接口，把结构化行情上下文转成单轮 messages 请求。"""
        messages = [
            {"role": "system", "content": AGENT_INSTRUCTIONS},
            {
                "role": "user",
                "content": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
            },
        ]
        try:
            response = await self.chat(messages)
            text = response.content or ""
            if not text:
                return AgentAnalysisResult.unavailable(
                    provider=self.name,
                    model=self.model,
                    error="Anthropic returned no output text.",
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

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ChatResponse:
        """调用 Anthropic Messages API，支持 Anthropic tool_use/tool_result 循环。"""
        api_key = _resolve_anthropic_api_key()
        system_text, anthropic_messages = _messages_to_anthropic(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self._max_tokens,
            "messages": anthropic_messages,
        }
        if system_text:
            payload["system"] = system_text
        if tools:
            payload["tools"] = _anthropic_tool_schemas(tools)

        url = _messages_endpoint(self._base_url)
        headers = _anthropic_headers(api_key, url)
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=payload, headers=headers)

        if response.status_code >= 400:
            raise LLMProviderError(_anthropic_error_message(response.status_code, response.text))
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise LLMProviderError("Anthropic returned a non-JSON response.") from exc
        if not isinstance(data, dict):
            raise LLMProviderError("Anthropic returned an invalid response.")
        return _parse_anthropic_response(data)

    async def list_models(self) -> list[dict[str, Any]]:
        """返回本地可配置的 Anthropic 模型列表。

        这个 proxy 的示例请求只暴露了 /messages。模型发现先保持本地静态列表；
        如需多个模型，可用 MYTRADEBOT_ANTHROPIC_MODELS 逗号分隔补充。
        """
        slugs = [self.model, DEFAULT_ANTHROPIC_MODEL]
        env_models = _first_env(ANTHROPIC_ENV_MODELS)
        if env_models:
            slugs.extend(item.strip() for item in env_models.split(","))
        return [_anthropic_model_option(slug) for slug in _unique_nonempty(slugs)]


def _first_env(names: tuple[str, ...]) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _resolve_anthropic_api_key() -> str:
    api_key = _first_env(ANTHROPIC_ENV_API_KEYS)
    if api_key:
        return api_key
    raise LLMProviderUnavailable(
        "No Anthropic API key found. Set MYTRADEBOT_ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN."
    )


def _resolve_max_tokens() -> int:
    raw_value = _first_env(ANTHROPIC_ENV_MAX_TOKENS)
    if not raw_value:
        return 1200
    try:
        return max(1, int(raw_value))
    except ValueError:
        return 1200


def _messages_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/messages"):
        return base
    if base.endswith("/v1"):
        return f"{base}/messages"
    return f"{base}/v1/messages"


def _anthropic_headers(api_key: str, url: str) -> dict[str, str]:
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }
    version = _first_env(("MYTRADEBOT_ANTHROPIC_VERSION", "ANTHROPIC_VERSION"))
    if version:
        headers["anthropic-version"] = version
    elif "api.anthropic.com" in url:
        headers["anthropic-version"] = "2023-06-01"
    return headers


def _messages_to_anthropic(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    output: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            text = _content_to_text(msg.get("content"))
            if text:
                system_parts.append(text)
            continue
        if role in ("user", "assistant"):
            converted = _convert_user_or_assistant_message(msg)
            if converted is not None:
                output.append(converted)
            continue
        if role == "tool":
            block = {
                "type": "tool_result",
                "tool_use_id": str(msg.get("tool_call_id") or ""),
                "content": _content_to_text(msg.get("content")),
            }
            _append_tool_result(output, block)
    return "\n\n".join(system_parts), output


def _convert_user_or_assistant_message(msg: dict[str, Any]) -> dict[str, Any] | None:
    role = msg.get("role")
    if role not in ("user", "assistant"):
        return None
    content = _content_to_text(msg.get("content"))
    tool_calls = msg.get("tool_calls")
    if role == "assistant" and isinstance(tool_calls, list) and tool_calls:
        blocks: list[dict[str, Any]] = []
        if content:
            blocks.append({"type": "text", "text": content})
        for raw_call in tool_calls:
            block = _tool_call_to_anthropic_block(raw_call)
            if block is not None:
                blocks.append(block)
        if blocks:
            return {"role": "assistant", "content": blocks}
        return None
    return {"role": str(role), "content": content}


def _tool_call_to_anthropic_block(raw_call: Any) -> dict[str, Any] | None:
    if not isinstance(raw_call, dict):
        return None
    raw_function = raw_call.get("function")
    if not isinstance(raw_function, dict):
        return None
    name = str(raw_function.get("name") or "").strip()
    if not name:
        return None
    raw_arguments = raw_function.get("arguments")
    arguments: dict[str, Any]
    if isinstance(raw_arguments, dict):
        arguments = raw_arguments
    elif isinstance(raw_arguments, str) and raw_arguments.strip():
        try:
            parsed = json.loads(raw_arguments)
            arguments = parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            arguments = {}
    else:
        arguments = {}
    return {
        "type": "tool_use",
        "id": str(raw_call.get("id") or ""),
        "name": name,
        "input": arguments,
    }


def _append_tool_result(output: list[dict[str, Any]], block: dict[str, Any]) -> None:
    if output:
        last = output[-1]
        content = last.get("content")
        if last.get("role") == "user" and isinstance(content, list):
            content.append(block)
            return
    output.append({"role": "user", "content": [block]})


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if text is not None:
                    parts.append(str(text))
        return "\n".join(part for part in parts if part)
    return str(content)


def _anthropic_tool_schemas(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    schemas: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            continue
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        name = str(function.get("name") or "").strip()
        if not name:
            continue
        schemas.append(
            {
                "name": name,
                "description": str(function.get("description") or ""),
                "input_schema": function.get("parameters") or {"type": "object"},
            }
        )
    return schemas


def _parse_anthropic_response(data: dict[str, Any]) -> ChatResponse:
    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    content = data.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text" and isinstance(block.get("text"), str):
                text_parts.append(block["text"])
            elif block_type == "tool_use":
                name = str(block.get("name") or "").strip()
                if not name:
                    continue
                raw_input = block.get("input")
                tool_calls.append(
                    ToolCall(
                        id=str(block.get("id") or ""),
                        name=name,
                        arguments=raw_input if isinstance(raw_input, dict) else {},
                    )
                )
    usage: dict[str, int] = {}
    raw_usage = data.get("usage")
    if isinstance(raw_usage, dict):
        for source_key, target_key in (
            ("input_tokens", "prompt_tokens"),
            ("output_tokens", "completion_tokens"),
        ):
            value = raw_usage.get(source_key)
            if isinstance(value, int):
                usage[target_key] = value
    return ChatResponse(
        content="".join(text_parts).strip() or None,
        tool_calls=tool_calls,
        finish_reason=str(data.get("stop_reason") or ("tool_calls" if tool_calls else "stop")),
        usage=usage,
    )


def _anthropic_error_message(status_code: int, body: str) -> str:
    detail = ""
    try:
        payload = json.loads(body)
        if isinstance(payload, dict):
            error = payload.get("error") or payload.get("detail") or payload.get("message")
            if isinstance(error, dict):
                detail = str(error.get("message") or error)
            elif error is not None:
                detail = str(error)
    except json.JSONDecodeError:
        detail = body.strip()[:200]
    suffix = f": {detail}" if detail else ""
    return f"Anthropic request failed: HTTP {status_code}{suffix}"


def _anthropic_model_option(slug: str) -> dict[str, Any]:
    return {
        "slug": slug,
        "displayName": slug,
        "description": "Anthropic Messages model",
        "visibility": "public",
        "supportedInApi": True,
        "defaultReasoningEffort": "",
        "supportedReasoningEfforts": [],
        "contextWindow": None,
        "preferWebsockets": False,
    }


def _unique_nonempty(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        item = value.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result
