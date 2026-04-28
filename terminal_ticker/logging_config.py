"""Configure application logging."""
from __future__ import annotations

import logging

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
DEFAULT_LOG_LEVEL = "INFO"


def configure_logging(level: str = DEFAULT_LOG_LEVEL) -> int:
    """Configure root logging and return the normalized numeric level."""
    normalized = level.strip().upper()
    numeric_level = getattr(logging, normalized, None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"unsupported log level: {level}")
    logging.basicConfig(level=numeric_level, format=LOG_FORMAT, force=True)
    logging.getLogger("uvicorn").setLevel(numeric_level)
    logging.getLogger("uvicorn.error").setLevel(numeric_level)
    logging.getLogger("uvicorn.access").setLevel(numeric_level)
    return numeric_level
