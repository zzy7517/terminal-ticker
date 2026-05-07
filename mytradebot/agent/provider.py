"""文件用途：Agent 层，定义 LLM provider 接口并创建实例。"""
from __future__ import annotations

from typing import Any, Protocol

from ..config import AgentConfig
from .loop import ChatResponse, StreamDeltaHandler


class LLMProviderUnavailable(RuntimeError):
    """说明：表示模型 provider 缺少凭证或运行环境不可用。"""


class LLMProviderError(RuntimeError):
    """说明：表示模型 provider 请求失败但配置本身可用。"""


class LLMProvider(Protocol):
    """说明：定义所有 transcript agent provider 必须实现的接口。"""

    name: str
    model: str

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        on_delta: StreamDeltaHandler | None = None,
    ) -> ChatResponse:
        """说明：执行一轮 transcript chat，可通过 on_delta 流式返回文本。"""


def create_llm_provider(config: AgentConfig) -> LLMProvider:
    """说明：根据配置创建 LLM provider。"""
    from .model_registry import DEFAULT_AGENT_MODEL_REGISTRY

    return DEFAULT_AGENT_MODEL_REGISTRY.create_provider(config)


async def list_available_agent_models(
    config: AgentConfig, *, provider_override: str | None = None,
) -> list[dict[str, Any]]:
    """说明：列出指定或当前 Agent provider 可用的模型。"""
    from .model_registry import DEFAULT_AGENT_MODEL_REGISTRY

    return await DEFAULT_AGENT_MODEL_REGISTRY.list_available_models(
        config, provider_override=provider_override,
    )
