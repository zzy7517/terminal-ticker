"""Codex provider for the Terminal Ticker analysis agent.

本模块负责把本地生成的结构化行情上下文发送给 Codex 后端，并把返回文本
转换成项目通用的 ``AgentAnalysisResult``。它的职责边界比较窄：

- 凭证解析：优先读取 ``TERMINAL_TICKER_CODEX_API_KEY`` / ``CODEX_API_KEY``，
  缺省时复用 Codex CLI 写入的 ``~/.codex/auth.json`` 登录态。
- 分析请求：使用 Codex Responses 风格的 ``/responses`` 流式接口，发送紧凑
  JSON 上下文，且设置 ``store=False``，避免服务端持久化本次分析输入。
- 模型发现：从 ``/models`` 拉取当前账号可见模型，再规范化为前端配置页使用
  的模型选项结构。
- 错误边界：对外只暴露可读的 provider 错误信息，避免把 access token 等敏感
  内容写入运行状态或 UI。
"""
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
from ..loop import ChatResponse, ToolCall as LoopToolCall
from ..provider import (
    AGENT_INSTRUCTIONS,
    AgentAnalysisResult,
    LLMProviderError,
    LLMProviderUnavailable,
    _result_from_text,
)

CODEX_ENV_API_KEYS = ("TERMINAL_TICKER_CODEX_API_KEY", "CODEX_API_KEY")


class CodexProvider:
    """通过 Codex Responses 风格接口完成行情分析的 LLM provider。

    这个类实现 ``terminal_ticker.agent.provider`` 中约定的 provider 行为：
    ``analyze`` 负责单次行情上下文分析，``list_models`` 负责给配置页刷新可用
    模型。它不做 K 线特征计算、策略信号生成或结果结构修正；这些上游/下游逻辑
    仍由 domain 层和通用解析函数负责。
    """

    name = CODEX_PROVIDER

    def __init__(self, config: AgentConfig, profile: AgentModelProfile | None = None) -> None:
        """初始化 provider 配置和模型配置。

        Args:
            config: Agent 运行配置，主要提供请求超时等运行时参数。
            profile: 可选的已解析模型配置。未传入时会从 ``AgentConfig`` 中解析。

        Raises:
            LLMProviderUnavailable: 当前模型配置不是 Codex 支持的 api_mode 时抛出。
        """
        self.config = config
        self.profile = profile or resolve_agent_model(config)
        if self.profile.api_mode != CODEX_API_MODE:
            raise LLMProviderUnavailable(f"Unsupported Codex api_mode: {self.profile.api_mode}")
        self.model = self.profile.model

    async def analyze(self, context: dict[str, Any]) -> AgentAnalysisResult:
        """分析一次结构化行情上下文，并把异常降级为 unavailable 结果。

        Args:
            context: 已由 API 层组装好的行情/策略上下文，必须可被 JSON 序列化。

        Returns:
            ``AgentAnalysisResult``。成功时来自 Codex 输出文本解析；凭证缺失、
            HTTP 错误、流式事件错误或空输出都会转换成 unavailable，避免实时
            ticker 运行循环因为单次 LLM 调用失败而中断。
        """
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
        """调用 Codex Responses 风格的流式分析接口。

        请求体把系统分析指令放在 ``instructions``，把结构化行情上下文压缩成
        单个 ``input_text``。这里显式使用 ``stream=True``，因为当前后端集成
        依赖 SSE 事件中的 ``response.output_text.delta`` / ``done`` 文本。

        Args:
            credentials: ``_resolve_codex_credentials`` 返回的凭证字典，至少包含
                ``api_key``，可能包含 ``account_id``。
            context: 要发送给模型的结构化行情上下文。

        Returns:
            包含 ``output_text`` 的字典，形状与非流式 Responses 常见返回保持接近，
            方便复用 ``_extract_response_text``。

        Raises:
            LLMProviderError: HTTP 非 2xx、流式事件报告失败或错误事件时抛出。
        """
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

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ChatResponse:
        """Agent loop 用的 chat 接口，走 Codex Responses API 并支持 tool calling。"""
        credentials = _resolve_codex_credentials()
        api_root = DEFAULT_CODEX_BASE_URL.rstrip("/")

        codex_input = _messages_to_codex_input(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "input": codex_input,
            "store": False,
            "stream": True,
            "reasoning": {
                "effort": self.profile.reasoning_effort,
                "summary": "auto",
            },
        }
        system_msg = next((m for m in messages if m.get("role") == "system"), None)
        if system_msg:
            payload["instructions"] = system_msg["content"]

        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "name": t["function"]["name"],
                    "description": t["function"].get("description", ""),
                    "parameters": t["function"].get("parameters", {}),
                }
                for t in tools
            ]

        headers = {
            "Authorization": f"Bearer {credentials['api_key']}",
            "Content-Type": "application/json",
            **_codex_request_headers(credentials["api_key"], credentials.get("account_id")),
        }
        timeout = httpx.Timeout(self.config.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", f"{api_root}/responses", json=payload, headers=headers,
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode(errors="replace")
                    raise LLMProviderError(_response_error_message(response.status_code, body))
                result = await _collect_response_stream_full(response)

        return result

    async def list_models(self) -> list[dict[str, Any]]:
        """拉取当前账号可见的 Codex 模型列表，供前端配置页展示。

        Returns:
            已规范化的模型选项列表。每个元素都包含 slug、展示名、可用 reasoning
            effort、上下文窗口等前端需要的字段。

        Raises:
            LLMProviderUnavailable: 无法解析 Codex 凭证时抛出。
            LLMProviderError: ``/models`` 返回错误或返回结构不符合预期时抛出。
        """
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
    """从 SSE 响应流中收集最终文本。

    Codex Responses 流会按行返回 ``data: ...`` 事件。正常文本可能以 delta 形式
    分片到达，也可能在 done 事件里给出完整文本；这里优先拼接 delta，缺省时
    回退到 done 文本。非 JSON 行、空 data 和 ``[DONE]`` 都按协议噪声跳过。

    Args:
        response: 已建立的 httpx 流式响应对象。

    Returns:
        去除首尾空白后的模型输出文本；如果没有任何可用文本则返回空字符串。

    Raises:
        LLMProviderError: 流中出现 ``response.failed``、``response.incomplete`` 或
        ``error`` 事件时抛出。
    """
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
    """把 HTTP 错误响应整理成不泄露凭证的 provider 错误信息。

    Args:
        status_code: HTTP 状态码。
        body: 响应体文本，可能是 JSON，也可能是纯文本。

    Returns:
        形如 ``Codex request failed: HTTP 401: ...`` 的可读错误。这里只提取
        detail/error/message 等服务端错误字段，不回显请求头、payload 或 token。
    """
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
    """规范化 Responses 流式错误事件中的错误信息。

    Args:
        event: 已解析的 SSE JSON 事件。

    Returns:
        面向 UI/日志的短错误文案。优先使用服务端返回的 message，其次使用 code，
        最后退回到事件 type，保证任何错误事件都有可展示的原因。
    """
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("code") or error
        return f"Codex request failed: {message}"
    if isinstance(error, str):
        return f"Codex request failed: {error}"
    return f"Codex request failed: {event.get('type') or 'stream error'}"


def _codex_model_option(item: dict[str, Any]) -> dict[str, Any]:
    """把 Codex ``/models`` 返回的单个模型对象规范化成前端选项。

    原始模型结构可能缺字段或字段类型不稳定，所以这里统一做防御式转换：字符串
    字段转成字符串，布尔字段转成布尔值，context window 只有在确认为整数时才
    传给前端。这样配置页刷新模型时不会因为单个异常模型对象崩掉。

    Args:
        item: ``/models`` 数组中的单个模型对象。

    Returns:
        前端 ``Agent Config`` 页面直接消费的模型 option 字典。
    """
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
    """从环境变量或 Codex CLI 登录文件解析可用凭证。

    解析顺序是有意设计的：显式环境变量优先，便于用户在当前进程或启动脚本中
    指定临时 token；没有环境变量时再复用 Codex CLI 的本地登录态，减少重复配置。

    Returns:
        至少包含 ``api_key`` 的凭证字典；从 CLI 登录态读取时还会尽量附带
        ``account_id``，供请求头构造使用。

    Raises:
        LLMProviderUnavailable: 环境变量和 CLI 登录态都不可用，或 CLI token 已过期。
    """
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
    """按顺序返回第一项非空环境变量值。

    Args:
        names: 要尝试读取的环境变量名，顺序代表优先级。

    Returns:
        去除首尾空白后的变量值；所有变量都不存在或为空时返回 ``None``。
    """
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def _codex_auth_path() -> Path:
    """返回 Codex CLI 登录态文件路径。

    ``CODEX_HOME`` 存在时优先使用它，方便测试或自定义安装目录；否则使用默认的
    ``~/.codex/auth.json``。这里只计算路径，不检查文件是否存在。

    Returns:
        展开 ``~`` 后的 auth.json 路径。
    """
    codex_home = os.getenv("CODEX_HOME", "").strip()
    if not codex_home:
        codex_home = str(Path.home() / ".codex")
    return Path(codex_home).expanduser() / "auth.json"


def _read_codex_cli_credentials() -> dict[str, str] | None:
    """读取 Codex CLI 本地登录凭证。

    这个函数只接受当前已经可用的 access token：文件不存在、JSON 损坏、结构不符
    或 token 为空都会返回 ``None``，让上层继续走“无凭证”降级。若 token 明确
    已过期，则抛出可读错误，提示用户重新运行 Codex CLI 刷新登录态。

    Returns:
        成功时返回 ``{"api_key": access_token, "account_id": ...}``；无法读取到
        可用登录态时返回 ``None``。

    Raises:
        LLMProviderUnavailable: access token 的 ``exp`` 已经过期时抛出。
    """
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
    """判断 JWT access token 是否已经过期或即将过期。

    Args:
        access_token: Codex CLI auth.json 中的 JWT access token。
        skew_seconds: 过期判断预留量。传 0 表示只判断是否已经过期。

    Returns:
        token 带有数值型 ``exp`` 且 ``exp <= 当前时间 + skew`` 时返回 ``True``。
        无法解析 ``exp`` 时返回 ``False``，把最终有效性留给服务端判断。
    """
    claims = _jwt_claims(access_token)
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= time.time() + max(0, skew_seconds)


def _jwt_claims(token: str) -> dict[str, Any]:
    """解析 JWT payload claims，供本地读取过期时间和账号 ID。

    这里只做 base64url 解码和 JSON 解析，不做签名校验，也不把它当作安全决策的
    唯一依据。解析失败时返回空字典，让调用方继续走保守分支。

    Args:
        token: JWT 字符串。

    Returns:
        JWT payload 中的 claims 字典；格式不合法或解析失败时返回空字典。
    """
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
    """构造 Codex CLI 风格的请求头。

    Codex 后端除了 bearer token 外，还会用 originator/User-Agent 和可选的
    ``ChatGPT-Account-ID`` 做账号上下文选择。调用方如果已经解析出 account_id，
    这里直接使用；否则会尝试从 JWT claims 中补齐。

    Args:
        access_token: 用于请求的 access token，同时可作为账号 ID 的兜底来源。
        account_id: 已解析出的 ChatGPT account id，可为空。

    Returns:
        可合并进 httpx 请求的 headers 字典；不会包含 Authorization。
    """
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


def _messages_to_codex_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把 OpenAI chat messages 格式转换成 Codex Responses API 的 input 格式。"""
    codex_input: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role", "")
        if role == "system":
            continue
        if role == "user":
            codex_input.append({
                "role": "user",
                "content": [{"type": "input_text", "text": msg.get("content", "")}],
            })
        elif role == "assistant":
            content_text = msg.get("content", "")
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                items: list[dict[str, Any]] = []
                if content_text:
                    items.append({"type": "output_text", "text": content_text})
                for tc in tool_calls:
                    func = tc.get("function", {})
                    items.append({
                        "type": "function_call",
                        "id": tc.get("id", ""),
                        "call_id": tc.get("id", ""),
                        "name": func.get("name", ""),
                        "arguments": func.get("arguments", "{}"),
                    })
                codex_input.append({"role": "assistant", "content": items})
            else:
                codex_input.append({
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": content_text}],
                })
        elif role == "tool":
            codex_input.append({
                "type": "function_call_output",
                "call_id": msg.get("tool_call_id", ""),
                "output": msg.get("content", ""),
            })
    return codex_input


async def _collect_response_stream_full(response: httpx.Response) -> ChatResponse:
    """收集 Responses API 流式响应，解析文本和 tool calls。"""
    text_chunks: list[str] = []
    done_text: str | None = None
    tool_calls: list[LoopToolCall] = []
    pending_fc: dict[str, dict[str, Any]] = {}

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
                text_chunks.append(delta)
        elif event_type == "response.output_text.done":
            text = event.get("text")
            if isinstance(text, str):
                done_text = text
        elif event_type == "response.function_call_arguments.delta":
            call_key = _function_call_event_key(event)
            if not call_key:
                continue
            if call_key not in pending_fc:
                pending_fc[call_key] = {
                    "call_id": event.get("call_id") or "",
                    "name": event.get("name", ""),
                    "arguments": "",
                }
            pending_fc[call_key]["arguments"] += event.get("delta", "")
        elif event_type == "response.function_call_arguments.done":
            call_key = _function_call_event_key(event)
            if not call_key:
                continue
            if call_key in pending_fc:
                if event.get("call_id"):
                    pending_fc[call_key]["call_id"] = event["call_id"]
                if event.get("name"):
                    pending_fc[call_key]["name"] = event["name"]
                pending_fc[call_key]["arguments"] = event.get("arguments", pending_fc[call_key]["arguments"])
            else:
                pending_fc[call_key] = {
                    "call_id": event.get("call_id") or "",
                    "name": event.get("name", ""),
                    "arguments": event.get("arguments", "{}"),
                }
        elif event_type in {"response.output_item.added", "response.output_item.done"}:
            item = event.get("item", {})
            if isinstance(item, dict) and item.get("type") == "function_call":
                call_key = _function_call_item_key(item, event)
                if not call_key:
                    continue
                if call_key not in pending_fc:
                    pending_fc[call_key] = {
                        "call_id": item.get("call_id") or item.get("id") or "",
                        "name": item.get("name", ""),
                        "arguments": item.get("arguments", "{}"),
                    }
                else:
                    if item.get("call_id"):
                        pending_fc[call_key]["call_id"] = item["call_id"]
                    if item.get("name"):
                        pending_fc[call_key]["name"] = item["name"]
                    if item.get("arguments"):
                        pending_fc[call_key]["arguments"] = item["arguments"]
        elif event_type in {"response.failed", "response.incomplete", "error"}:
            raise LLMProviderError(_event_error_message(event))

    for call_key, fc_data in pending_fc.items():
        name = str(fc_data.get("name") or "").strip()
        if not name:
            continue
        call_id = str(fc_data.get("call_id") or call_key).strip()
        try:
            args = json.loads(fc_data["arguments"]) if fc_data["arguments"] else {}
        except json.JSONDecodeError:
            args = {}
        tool_calls.append(LoopToolCall(
            id=call_id,
            name=name,
            arguments=args,
        ))

    text = "".join(text_chunks).strip() or (done_text or "").strip()

    return ChatResponse(
        content=text if text else None,
        tool_calls=tool_calls,
        finish_reason="tool_calls" if tool_calls else "stop",
    )


def _function_call_event_key(event: dict[str, Any]) -> str:
    """Return the stable key used by Responses function-call argument events."""
    for key in ("item_id", "call_id", "id"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    output_index = event.get("output_index")
    if isinstance(output_index, int):
        return f"output:{output_index}"
    return ""


def _function_call_item_key(item: dict[str, Any], event: dict[str, Any]) -> str:
    """Return the key shared by function_call output item and argument events."""
    item_id = item.get("id")
    if isinstance(item_id, str) and item_id:
        return item_id
    call_id = item.get("call_id")
    if isinstance(call_id, str) and call_id:
        return call_id
    output_index = event.get("output_index")
    if isinstance(output_index, int):
        return f"output:{output_index}"
    return ""


def _extract_response_text(data: dict[str, Any]) -> str:
    """从 Responses 风格返回结构中提取文本。

    当前流式路径会传入 ``{"output_text": ...}``，但这个函数也兼容常见的非流式
    ``output[].content`` 结构，方便将来切换请求模式或复用解析逻辑。无法识别的
    content 会被跳过，而不是抛异常。

    Args:
        data: Responses 风格的响应数据。

    Returns:
        拼接并去除首尾空白后的文本；没有可识别文本时返回空字符串。
    """
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
