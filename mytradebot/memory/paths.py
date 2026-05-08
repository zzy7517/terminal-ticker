"""文件用途：mytradebot 记忆目录布局辅助函数。"""
from __future__ import annotations

import os
from pathlib import Path

MEMORY_HOME_ENV = "MYTRADEBOT_MEMORY_HOME"
DEFAULT_DATA_SUBDIR = "mytradebot"
DEFAULT_MEMORY_DIRNAME = "memories"
STATE_DB_FILENAME = "state.sqlite3"
MEMORY_DIRS = (
    "facts",
    "reviews",
    "rollout_summaries",
    "skills",
    "evidence",
    "extensions/ad_hoc/notes",
)


def default_data_dir() -> Path:
    """说明：返回默认的用户级数据目录。"""
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / DEFAULT_DATA_SUBDIR


def default_memory_home() -> Path:
    """说明：返回默认 memories root。"""
    return default_data_dir() / DEFAULT_MEMORY_DIRNAME


def memory_home(path: str | Path | None = None) -> Path:
    """说明：解析当前使用的 memories root。

    `MYTRADEBOT_MEMORY_HOME` 指向 memories root 本身，而不是上层应用目录。
    """
    if path is not None:
        return Path(path).expanduser()
    configured = os.environ.get(MEMORY_HOME_ENV)
    if configured:
        return Path(configured).expanduser()
    return default_memory_home()


def memory_store_available(path: str | Path | None = None) -> bool:
    """说明：判断可读的 memories root 是否存在。"""
    root = memory_home(path)
    return root.exists() and root.is_dir()


def memory_state_path(path: str | Path | None = None) -> Path:
    """说明：返回 memories root 下的 SQLite 状态库路径。"""
    return memory_home(path) / STATE_DB_FILENAME


def ensure_memory_layout(path: str | Path | None = None) -> Path:
    """说明：创建本地记忆目录结构并返回 root。"""
    root = memory_home(path)
    root.mkdir(parents=True, exist_ok=True)
    # 目录创建集中在这里，避免读工具和写入流水线对磁盘布局产生分歧。
    for dirname in MEMORY_DIRS:
        (root / dirname).mkdir(parents=True, exist_ok=True)
    return root
