"""文件用途：领域层，定义标准化 K 线数据。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Candle:
    """说明：封装一根标准化 OHLCV K 线。"""
    symbol_key: str
    open_time_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        """说明：在数据对象创建后校验字段合法性。"""
        if self.high < max(self.open, self.close, self.low):
            raise ValueError("candle high must be greater than or equal to open, low, and close")
        if self.low > min(self.open, self.close, self.high):
            raise ValueError("candle low must be less than or equal to open, high, and close")

    @property
    def range(self) -> float:
        """说明：返回 K 线最高价和最低价之间的范围。"""
        return self.high - self.low

    @property
    def body(self) -> float:
        """说明：返回 K 线实体大小。"""
        return abs(self.close - self.open)
