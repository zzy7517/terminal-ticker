"""工具系统基础设施：注册表、数据结构、钩子类型和执行引擎。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from inspect import isawaitable
from typing import Any, Awaitable, Callable

ToolHandler = Callable[..., Awaitable[str]]


@dataclass(frozen=True)
class ToolDefinition:
    """一个可被 LLM 调用的工具定义。"""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler


@dataclass
class ToolCall:
    """模型返回的一次工具调用。"""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolResult:
    """工具执行结果。"""

    call_id: str
    name: str
    output: str
    error: bool = False


BeforeToolHook = Callable[[ToolCall, ToolDefinition], ToolCall | None | Awaitable[ToolCall | None]]
AfterToolHook = Callable[
    [ToolCall, ToolResult, ToolDefinition],
    ToolResult | None | Awaitable[ToolResult | None],
]


class ToolRegistry:
    """管理所有可用工具的注册表。"""

    def __init__(
        self,
        *,
        before_tool_hooks: tuple[BeforeToolHook, ...] = tuple(),
        after_tool_hooks: tuple[AfterToolHook, ...] = tuple(),
    ) -> None:
        """初始化工具注册表，可选配置调用前后的钩子。"""
        self._tools: dict[str, ToolDefinition] = {}
        self._before_tool_hooks = before_tool_hooks
        self._after_tool_hooks = after_tool_hooks

    def extend_hooks(
        self,
        *,
        before_tool_hooks: tuple[BeforeToolHook, ...] = tuple(),
        after_tool_hooks: tuple[AfterToolHook, ...] = tuple(),
    ) -> None:
        """追加 runtime 级工具钩子，用于审计、权限或参数改写。"""
        self._before_tool_hooks = (*self._before_tool_hooks, *before_tool_hooks)
        self._after_tool_hooks = (*self._after_tool_hooks, *after_tool_hooks)

    def register(self, tool: ToolDefinition) -> None:
        """注册一个工具定义到注册表中。"""
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDefinition | None:
        """按名称查找并返回工具定义。"""
        return self._tools.get(name)

    def list_tools(self) -> list[ToolDefinition]:
        """返回所有已注册工具的列表。"""
        return list(self._tools.values())

    def openai_tool_schemas(self) -> list[dict[str, Any]]:
        """生成 OpenAI function calling 格式的 tool schema 列表。"""
        schemas: list[dict[str, Any]] = []
        for tool in self._tools.values():
            schemas.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            })
        return schemas

    def codex_tool_schemas(self) -> list[dict[str, Any]]:
        """生成 Codex Responses API 格式的 tool schema 列表。"""
        schemas: list[dict[str, Any]] = []
        for tool in self._tools.values():
            schemas.append({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        return schemas

    async def execute(self, call: ToolCall) -> ToolResult:
        """执行一次工具调用并返回结果。"""
        tool = self._tools.get(call.name)
        if tool is None:
            return ToolResult(
                call_id=call.id,
                name=call.name,
                output=f"Unknown tool: {call.name}",
                error=True,
            )
        effective_call = call
        try:
            for hook in self._before_tool_hooks:
                replacement = await _maybe_await(hook(effective_call, tool))
                if isinstance(replacement, ToolCall):
                    effective_call = replacement
            output = await tool.handler(**effective_call.arguments)
            result = ToolResult(call_id=effective_call.id, name=effective_call.name, output=output)
        except Exception as exc:
            result = ToolResult(
                call_id=effective_call.id,
                name=effective_call.name,
                output=str(exc) or exc.__class__.__name__,
                error=True,
            )
        for hook in self._after_tool_hooks:
            replacement = await _maybe_await(hook(effective_call, result, tool))
            if isinstance(replacement, ToolResult):
                result = replacement
        return result


def _json_output(data: Any) -> str:
    """将数据序列化为紧凑的 JSON 字符串。"""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


async def _maybe_await(value: Any) -> Any:
    """若值为可等待对象则 await，否则直接返回。"""
    if isawaitable(value):
        return await value
    return value


def merge_registries(*registries: ToolRegistry) -> ToolRegistry:
    """合并多个工具注册表到一个新注册表。"""
    merged = ToolRegistry()
    for registry in registries:
        for tool in registry.list_tools():
            merged.register(tool)
    return merged
