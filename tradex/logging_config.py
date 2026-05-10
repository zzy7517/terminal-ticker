"""文件用途：日志配置，统一初始化后端日志级别和格式。"""
from __future__ import annotations

import logging

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
DEFAULT_LOG_LEVEL = "INFO"
LOG_LEVEL_NAMES = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
_LOG_LEVEL_VALUES = {name: getattr(logging, name) for name in LOG_LEVEL_NAMES}
_MANAGED_LOGGERS = (
    "tradex",
    "uvicorn",
    "uvicorn.error",
    "uvicorn.access",
    "uvicorn.asgi",
)


def normalize_log_level(level: str) -> str:
    """Return the canonical uppercase logging level name."""
    normalized = level.strip().upper()
    if normalized not in _LOG_LEVEL_VALUES:
        raise ValueError(f"unsupported log level: {level}")
    return normalized


def uvicorn_log_level(level: str) -> str:
    """Return the lowercase level string expected by Uvicorn."""
    return normalize_log_level(level).lower()


def configure_logging(level: str = DEFAULT_LOG_LEVEL) -> int:
    """说明：初始化根日志配置并返回标准化日志级别。"""
    normalized = normalize_log_level(level)
    numeric_level = _LOG_LEVEL_VALUES[normalized]
    logging.basicConfig(level=numeric_level, format=LOG_FORMAT, force=True)
    for logger_name in _MANAGED_LOGGERS:
        logger = logging.getLogger(logger_name)
        logger.setLevel(numeric_level)
        if logger_name.startswith("uvicorn"):
            logger.handlers.clear()
        logger.propagate = True
    return numeric_level
