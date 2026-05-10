"""文件用途：控制一次 agent/runtime 是否允许读写本地记忆。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MemoryRuntimePolicy:
    """说明：tradex 版的 Codex memory 运行策略。

    `ephemeral` 不是 OS 级沙箱；它只表达“这个临时 worker 不能读记忆、
    也不能生成新记忆”，用来切断 consolidation 之类内部任务的递归入口。
    """

    ephemeral: bool = False
    generate_memories: bool = True
    use_memories: bool = True

    def __post_init__(self) -> None:
        if self.ephemeral:
            object.__setattr__(self, "generate_memories", False)
            object.__setattr__(self, "use_memories", False)

    @classmethod
    def normal(cls) -> "MemoryRuntimePolicy":
        """说明：普通交互会话，允许读已有记忆，也允许后台生成记忆。"""
        return cls()

    @classmethod
    def consolidation(cls) -> "MemoryRuntimePolicy":
        """说明：Phase 2 内部整理 worker，禁止递归读写记忆。"""
        return cls(ephemeral=True)

    @classmethod
    def disabled(cls) -> "MemoryRuntimePolicy":
        """说明：显式关闭 memory 的读写入口。"""
        return cls(generate_memories=False, use_memories=False)


__all__ = ["MemoryRuntimePolicy"]
