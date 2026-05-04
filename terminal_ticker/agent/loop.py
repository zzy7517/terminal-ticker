"""Agent Loop 核心引擎：编排 用户输入 → 模型推理 → 工具调用 → 循环。

参考 OpenAI Codex 和 Nous Hermes 的 agent loop 设计：
- 每轮：构建 prompt → 模型推理 → 判断响应类型
  - 文本响应 → 返回（turn 结束）
  - tool_calls → 执行工具 → 追加结果到历史 → 重新推理（循环）
- 迭代预算防止无限循环
- 对话历史保持 OpenAI message 格式
- 工具结果按调用顺序追加
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from .tools import ToolCall, ToolRegistry, ToolResult

logger = logging.getLogger(__name__)

DEFAULT_MAX_ITERATIONS = 10
DEFAULT_SYSTEM_PROMPT = """你是一个本地运行的 price action trading assistant。
你可以调用工具来获取实时行情、K 线和策略信号。基于工具返回的真实数据做分析。
你不下单、不管理仓位、不承诺收益，也不把分析表述成确定性金融建议。

分析完成后，输出一个 JSON object，字段必须是：
summary: string
bias: "bullish" | "bearish" | "neutral" | "mixed"
confidence: integer 0-100
key_levels: array of {label: string, price: number | null, reason: string}
watch_plan: array of string
invalidation: string
risk_notes: array of string"""


class AgentLLMProvider(Protocol):
    """Agent loop 要求 LLM provider 实现的接口。"""

    name: str
    model: str

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
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

    step_type: str  # "tool_call" | "tool_result" | "assistant"
    tool_call: ToolCall | None = None
    tool_result: ToolResult | None = None
    content: str | None = None
    timestamp: float = 0.0

    def to_payload(self) -> dict[str, Any]:
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
        if self.content is not None:
            payload["content"] = self.content
        return payload


@dataclass
class LoopResult:
    """Agent loop 执行完成的完整结果。"""

    content: str
    steps: list[LoopStep] = field(default_factory=list)
    iterations: int = 0
    total_tokens: int = 0
    finished: bool = True
    error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "steps": [step.to_payload() for step in self.steps],
            "iterations": self.iterations,
            "totalTokens": self.total_tokens,
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
    ) -> LoopResult:
        """执行 agent loop，直到模型产生文本响应或达到迭代上限。"""
        messages = self._build_messages(user_message, conversation_history)
        tool_schemas = self.tools.openai_tool_schemas()

        steps: list[LoopStep] = []
        total_tokens = 0
        iteration = 0

        while iteration < self.max_iterations:
            iteration += 1
            logger.info(
                "agent loop iteration %d/%d, messages=%d",
                iteration, self.max_iterations, len(messages),
            )

            try:
                response = await self.provider.chat(
                    messages=messages,
                    tools=tool_schemas if tool_schemas else None,
                )
            except Exception as exc:
                logger.error("agent loop provider error: %s", exc)
                return LoopResult(
                    content="",
                    steps=steps,
                    iterations=iteration,
                    total_tokens=total_tokens,
                    finished=False,
                    error=str(exc) or exc.__class__.__name__,
                )

            total_tokens += sum(response.usage.values())

            if not response.tool_calls:
                content = response.content or ""
                steps.append(LoopStep(
                    step_type="assistant",
                    content=content,
                    timestamp=time.time(),
                ))
                return LoopResult(
                    content=content,
                    steps=steps,
                    iterations=iteration,
                    total_tokens=total_tokens,
                )

            assistant_msg: dict[str, Any] = {"role": "assistant", "content": response.content or ""}
            assistant_msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": _serialize_arguments(tc.arguments),
                    },
                }
                for tc in response.tool_calls
            ]
            messages.append(assistant_msg)

            for tc in response.tool_calls:
                steps.append(LoopStep(
                    step_type="tool_call",
                    tool_call=tc,
                    timestamp=time.time(),
                ))

                result = await self.tools.execute(tc)

                steps.append(LoopStep(
                    step_type="tool_result",
                    tool_result=result,
                    timestamp=time.time(),
                ))

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result.output,
                })

        return LoopResult(
            content="Agent reached maximum iteration limit.",
            steps=steps,
            iterations=iteration,
            total_tokens=total_tokens,
            finished=False,
            error=f"Reached max iterations ({self.max_iterations})",
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


import json as _json


def _serialize_arguments(arguments: dict[str, Any]) -> str:
    return _json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
