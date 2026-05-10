"""Agent Loop 核心引擎：编排 transcript message、模型推理和工具调用。"""
from __future__ import annotations

import inspect
import logging
import time
import uuid
import json as _json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .tools import ToolCall, ToolRegistry, ToolResult

logger = logging.getLogger(__name__)

DEFAULT_MAX_ITERATIONS = 10
DEFAULT_SYSTEM_PROMPT = """你是一名做加密货币永续合约的职业 trader，擅长 price action 与 Smart Money Concepts，习惯用衍生品数据交叉验证判断。用户在前端跟你协作盯盘和决策，你不是助手，是他的交易搭子。

## 核心工作原则

1. **回答严格围绕用户的问题**。用户问什么答什么，不要把每次对话都变成完整盘前分析。需要数据再调工具，不需要就直接答；不要为了显得专业去堆术语或多周期分析。
2. **结论先于论据**。先给方向/答案，再给支撑理由和关键位，不要倒着写。
3. **数据来自工具，不是记忆**。涉及行情、K 线、持仓、成交、新闻的事实判断，必须先调工具拿当前数据，不要用历史经验或训练记忆替代。引用具体价位/时间时把来源说清。
4. **该判断就判断，该承认不知道就承认**。数据足够支持判断时直接给方向和理由，不要骑墙；工具拿不到、数据不足、信号互相矛盾时如实讲，不要硬凑叙事。

## 分析方法论（需要做行情判断时遵循）

**多周期自上而下**：先确定大周期方向再找小周期入场。默认顺序 日线 → 4H → 1H → 15m → 5m，根据用户关心的时间尺度截取其中几层即可，不必每次跑全。
- 大周期定方向（趋势 / 区间 / 关键供需）
- 中周期定结构（BOS/CHoCH、order block、FVG、流动性池位置）
- 小周期定触发（入场确认、失效条件）

**Price Action + SMC 框架**：关注市场结构变化、流动性扫荡（liquidity sweep）、供需区反应、订单块回踩、公允价值缺口的填补与否。永续合约还要看资金费率、未平仓量、主动成交方向这类衍生品信号做交叉验证（有工具就调）。

**风险先于收益**：任何方向判断都要附带失效条件（什么价位/什么结构出现就证明判断错了）。没有清晰失效条件的判断不是交易级判断。

## 何时主动提示开仓

当且仅当**同时满足**以下条件时，明确告诉用户「现在满足开仓条件」并给出完整交易计划（方向、入场区间、止损、止盈/减仓位、仓位建议、失效条件）：
- 多周期方向一致或至少不冲突
- 当前小周期出现可执行的入场触发（结构确认、流动性扫荡后回收、关键位反应等具体信号）
- 失效点清晰且 R:R 合理

不满足就如实说还在等什么信号，不要为了给信号而给信号。

## 工具与执行边界

- 行情、K 线、新闻、社交、本地交易记录、网页检索：随时按需调用
- 下单、平仓、调整止盈止损：只能在配置开放对应平台时调用对应工具，未开放就只能给计划不能执行（具体平台权限见下方说明）

## 输出格式

默认中文，自然语言。结构按需要决定：
- 简单问答 → 一两句话直接答
- 行情判断 → 「结论 → 多周期依据 → 关键位 → 失效条件」的顺序
- 交易计划 → 列清入场、止损、止盈、仓位、失效
- 用户明确要 JSON 时再给 JSON"""

# 模型流式输出时，每产生一段文字碎片就调用一次的回调（支持同步/异步）
StreamDeltaHandler = Callable[[str], Awaitable[None] | None]
# agent 生命周期事件回调，负责把运行状态（开始/吐字/工具调用/结束等）推送给外部（支持同步/异步）
AgentEventHandler = Callable[[dict[str, Any]], Awaitable[None] | None]


class AgentLLMProvider(Protocol):
    """Agent loop 要求 LLM provider 实现的接口。"""

    name: str
    model: str

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        on_delta: StreamDeltaHandler | None = None,
    ) -> "ChatResponse": ...


@dataclass
class ChatResponse:
    """LLM provider 的 chat 响应。"""

    content: str | None = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: dict[str, int] = field(default_factory=dict)


@dataclass
class LoopStep:
    """Agent loop 中的一步。"""

    step_type: str  # "tool_call" | "tool_result"
    tool_call: ToolCall | None = None
    tool_result: ToolResult | None = None
    timestamp: float = 0.0

    def to_payload(self) -> dict[str, Any]:
        """序列化为前端可消费的 JSON 字典。"""
        payload: dict[str, Any] = {
            "stepType": self.step_type,
            "timestamp": self.timestamp,
        }
        if self.tool_call is not None:
            payload["toolCall"] = {
                "id": self.tool_call.id,
                "name": self.tool_call.name,
                "arguments": self.tool_call.arguments,
            }
        if self.tool_result is not None:
            payload["toolResult"] = {
                "callId": self.tool_result.call_id,
                "name": self.tool_result.name,
                "output": self.tool_result.output[:2000],
                "error": self.tool_result.error,
            }
        return payload


@dataclass
class TranscriptMessage:
    """一条可持久化和渲染的 agent transcript 消息。"""

    role: str
    content: str
    metadata: dict[str, Any] | None = None
    error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """序列化为前端可消费的 JSON 字典。"""
        return {
            "role": self.role,
            "content": self.content,
            "metadata": self.metadata,
            "error": self.error,
        }


@dataclass
class LoopResult:
    """Agent loop 执行完成的完整结果。"""

    content: str
    steps: list[LoopStep] = field(default_factory=list)
    messages: list[TranscriptMessage] = field(default_factory=list)
    iterations: int = 0
    total_tokens: int = 0
    prompt_tokens: int = 0
    finished: bool = True
    error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """序列化为前端可消费的 JSON 字典。"""
        return {
            "content": self.content,
            "steps": [step.to_payload() for step in self.steps],
            "messages": [message.to_payload() for message in self.messages],
            "iterations": self.iterations,
            "totalTokens": self.total_tokens,
            "promptTokens": self.prompt_tokens,
            "finished": self.finished,
            "error": self.error,
        }


class AgentLoop:
    """编排 LLM 推理和工具调用的核心循环。"""

    def __init__(
        self,
        *,
        provider: AgentLLMProvider,
        tools: ToolRegistry,
        system_prompt: str | None = None,
        max_iterations: int = DEFAULT_MAX_ITERATIONS,
    ) -> None:
        self.provider = provider
        self.tools = tools
        self.system_prompt = system_prompt or DEFAULT_SYSTEM_PROMPT
        self.max_iterations = max_iterations

    async def run(
        self,
        user_message: str,
        conversation_history: list[dict[str, Any]] | None = None,
        event_handler: AgentEventHandler | None = None,
    ) -> LoopResult:
        """执行 agent loop，直到模型产生文本响应或达到迭代上限。"""
        messages = self._build_messages(user_message, conversation_history)
        tool_schemas = self.tools.openai_tool_schemas()

        steps: list[LoopStep] = []
        transcript_messages: list[TranscriptMessage] = []
        total_tokens = 0
        prompt_tokens = 0
        usage_supported = False
        iteration = 0
        await _emit(event_handler, {"type": "agent_start"})

        while iteration < self.max_iterations:
            iteration += 1
            logger.info(
                "agent loop iteration %d/%d, messages=%d",
                iteration, self.max_iterations, len(messages),
            )
            await _emit(event_handler, {"type": "turn_start", "iteration": iteration})

            try:
                assistant_client_id = f"assistant:{uuid.uuid4()}"
                streamed_parts: list[str] = []
                await _emit(
                    event_handler,
                    {
                        "type": "message_start",
                        "message": {
                            "clientId": assistant_client_id,
                            "role": "assistant",
                            "content": "",
                            "metadata": None,
                            "error": None,
                        },
                    },
                )

                async def on_delta(delta: str) -> None:
                    streamed_parts.append(delta)
                    await _emit(
                        event_handler,
                        {
                            "type": "message_update",
                            "message": {
                                "clientId": assistant_client_id,
                                "role": "assistant",
                                "content": "",
                                "metadata": None,
                                "error": None,
                            },
                            "delta": delta,
                        },
                    )

                chat_kwargs: dict[str, Any] = {
                    "messages": messages,
                    "tools": tool_schemas if tool_schemas else None,
                }
                if _accepts_on_delta(self.provider.chat):
                    chat_kwargs["on_delta"] = on_delta
                response = await self.provider.chat(**chat_kwargs)
            except Exception as exc:
                logger.error("agent loop provider error: %s", exc)
                error_text = str(exc) or exc.__class__.__name__
                await _emit(event_handler, {"type": "error", "error": error_text})
                await _emit(
                    event_handler,
                    _agent_end_event(
                        error_text,
                        total_tokens=total_tokens,
                        prompt_tokens=prompt_tokens,
                        usage_supported=usage_supported,
                    ),
                )
                return LoopResult(
                    content="",
                    steps=steps,
                    messages=transcript_messages,
                    iterations=iteration,
                    total_tokens=total_tokens,
                    prompt_tokens=prompt_tokens,
                    finished=False,
                    error=error_text,
                )

            if response.usage:
                usage_supported = True
            response_tokens = sum(response.usage.values())
            total_tokens += response_tokens
            prompt_tokens = response.usage.get("prompt_tokens", prompt_tokens)
            content = response.content or "".join(streamed_parts)
            tool_call_payloads = _tool_call_metadata(response.tool_calls)
            assistant_metadata: dict[str, Any] = {}
            if tool_call_payloads:
                assistant_metadata["toolCalls"] = tool_call_payloads
            usage_metadata = _usage_metadata(
                response.usage,
                response_tokens=response_tokens,
                run_total_tokens=total_tokens,
                context_prompt_tokens=prompt_tokens,
            )
            if usage_metadata is not None:
                assistant_metadata["usage"] = usage_metadata
            assistant_message = TranscriptMessage(
                role="assistant",
                content=content,
                metadata=assistant_metadata or None,
            )
            transcript_messages.append(assistant_message)
            await _emit(
                event_handler,
                {
                    "type": "message_end",
                    "message": {
                        "clientId": assistant_client_id,
                        **assistant_message.to_payload(),
                    },
                },
            )

            if not response.tool_calls:
                if not content.strip():
                    error_text = "Agent returned no output text."
                    await _emit(event_handler, {"type": "error", "error": error_text})
                    await _emit(
                        event_handler,
                        _agent_end_event(
                            error_text,
                            total_tokens=total_tokens,
                            prompt_tokens=prompt_tokens,
                            usage_supported=usage_supported,
                        ),
                    )
                    return LoopResult(
                        content="",
                        steps=steps,
                        messages=transcript_messages,
                        iterations=iteration,
                        total_tokens=total_tokens,
                        prompt_tokens=prompt_tokens,
                        finished=False,
                        error=error_text,
                    )
                await _emit(event_handler, {"type": "turn_end", "iteration": iteration})
                await _emit(
                    event_handler,
                    _agent_end_event(
                        None,
                        total_tokens=total_tokens,
                        prompt_tokens=prompt_tokens,
                        usage_supported=usage_supported,
                    ),
                )
                return LoopResult(
                    content=content,
                    steps=steps,
                    messages=transcript_messages,
                    iterations=iteration,
                    total_tokens=total_tokens,
                    prompt_tokens=prompt_tokens,
                )

            assistant_msg: dict[str, Any] = {"role": "assistant", "content": content}
            assistant_msg["tool_calls"] = _openai_tool_call_payloads(response.tool_calls)
            messages.append(assistant_msg)

            for tc in response.tool_calls:
                tool_call_payload = _tool_call_payload(tc)
                steps.append(LoopStep(
                    step_type="tool_call",
                    tool_call=tc,
                    timestamp=time.time(),
                ))
                await _emit(
                    event_handler,
                    {
                        "type": "tool_execution_start",
                        "toolCall": tool_call_payload,
                    },
                )

                result = await self.tools.execute(tc)

                steps.append(LoopStep(
                    step_type="tool_result",
                    tool_result=result,
                    timestamp=time.time(),
                ))
                tool_result_payload = _tool_result_payload(result)
                await _emit(
                    event_handler,
                    {
                        "type": "tool_execution_end",
                        "toolCall": tool_call_payload,
                        "toolResult": tool_result_payload,
                    },
                )
                tool_message = TranscriptMessage(
                    role="toolResult",
                    content=result.output,
                    metadata={
                        "toolCallId": result.call_id,
                        "toolName": result.name,
                        "error": result.error,
                    },
                    error=result.output if result.error else None,
                )
                transcript_messages.append(tool_message)
                await _emit(
                    event_handler,
                    {
                        "type": "message_end",
                        "message": tool_message.to_payload(),
                    },
                )

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result.output,
                })
            await _emit(event_handler, {"type": "turn_end", "iteration": iteration})

        error_text = f"Reached max iterations ({self.max_iterations})"
        await _emit(event_handler, {"type": "error", "error": error_text})
        await _emit(
            event_handler,
            _agent_end_event(
                error_text,
                total_tokens=total_tokens,
                prompt_tokens=prompt_tokens,
                usage_supported=usage_supported,
            ),
        )
        return LoopResult(
            content="Agent reached maximum iteration limit.",
            steps=steps,
            messages=transcript_messages,
            iterations=iteration,
            total_tokens=total_tokens,
            prompt_tokens=prompt_tokens,
            finished=False,
            error=error_text,
        )

    def _build_messages(
        self,
        user_message: str,
        conversation_history: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        """构建发送给模型的消息列表。"""
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
        ]
        if conversation_history:
            for msg in conversation_history:
                role = msg.get("role", "")
                if role in ("user", "assistant"):
                    messages.append({
                        "role": role,
                        "content": str(msg.get("content", "")),
                    })
        messages.append({"role": "user", "content": user_message})
        return messages


def _serialize_arguments(arguments: dict[str, Any]) -> str:
    """将工具调用参数序列化为紧凑 JSON 字符串。"""
    return _json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))


def _accepts_on_delta(chat: Any) -> bool:
    """检查 provider.chat 方法签名中是否接受 on_delta 参数。"""
    try:
        signature = inspect.signature(chat)
    except (TypeError, ValueError):
        return True
    return "on_delta" in signature.parameters


async def _emit(handler: AgentEventHandler | None, event: dict[str, Any]) -> None:
    """调用事件回调，自动兼容同步和异步 handler。"""
    if handler is None:
        return
    result = handler(event)
    if inspect.isawaitable(result):
        await result


def _tool_call_payload(call: ToolCall) -> dict[str, Any]:
    """将单个 ToolCall 转换为前端事件用的字典。"""
    return {
        "id": call.id,
        "name": call.name,
        "arguments": call.arguments,
    }


def _tool_call_metadata(tool_calls: list[ToolCall]) -> list[dict[str, Any]]:
    """批量将 ToolCall 列表转换为 metadata 字典列表。"""
    return [_tool_call_payload(call) for call in tool_calls]


def _openai_tool_call_payloads(tool_calls: list[ToolCall]) -> list[dict[str, Any]]:
    """将 ToolCall 列表转换为 OpenAI function calling 格式，用于拼入 messages。"""
    return [
        {
            "id": tc.id,
            "type": "function",
            "function": {
                "name": tc.name,
                "arguments": _serialize_arguments(tc.arguments),
            },
        }
        for tc in tool_calls
    ]


def _usage_metadata(
    usage: dict[str, int],
    *,
    response_tokens: int,
    run_total_tokens: int,
    context_prompt_tokens: int,
) -> dict[str, int] | None:
    """将 LLM 返回的 token 用量组装为前端展示用的 metadata 字典。"""
    if not usage:
        return None
    payload: dict[str, int] = {
        "totalTokens": response_tokens,
        "runTotalTokens": run_total_tokens,
        "contextPromptTokens": context_prompt_tokens,
    }
    prompt = usage.get("prompt_tokens")
    if isinstance(prompt, int):
        payload["promptTokens"] = prompt
    completion = usage.get("completion_tokens")
    if isinstance(completion, int):
        payload["completionTokens"] = completion
    return payload


def _agent_end_event(
    error: str | None,
    *,
    total_tokens: int,
    prompt_tokens: int,
    usage_supported: bool,
) -> dict[str, Any]:
    """构造 agent_end 事件，附带 token 用量（如果 provider 支持）。"""
    event: dict[str, Any] = {"type": "agent_end", "error": error}
    if usage_supported:
        event["totalTokens"] = total_tokens
        event["promptTokens"] = prompt_tokens
    return event


def _tool_result_payload(result: ToolResult) -> dict[str, Any]:
    """将工具执行结果转换为前端事件用的字典，output 截断到 2000 字符。"""
    return {
        "callId": result.call_id,
        "name": result.name,
        "output": result.output[:2000],
        "error": result.error,
    }
