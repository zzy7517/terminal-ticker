# 快速验证：价格提醒

## 1. 配置提醒规则

实现后，配置文件大致长这样：

```toml
symbols = [
  { symbol = "BTCUSDT", inst_type = "USDT-FUTURES", label = "BTC", alerts = [
    { when = "above", price = 80000, name = "Breakout" },
    { when = "below", price = 76000, name = "Support Lost" },
  ] },
  { symbol = "ETHUSDT", inst_type = "USDT-FUTURES", label = "ETH", alerts = [
    { when = "above", price = 4200, name = "ETH Strength" },
  ] },
]
```

## 2. 启动程序

```bash
python3 -m terminal_ticker --config watchlist.toml
```

## 3. 验证基础提醒

1. 先让价格在阈值未触发的一侧。
2. 等待新鲜行情穿越阈值。
3. 确认出现提醒。
4. 确认价格仍正常更新，折叠状态也不会自动展开。

## 4. 验证去重和重新 arm

1. 价格停留在触发区间时，不应连续重复提醒。
2. 价格回到另一侧后，再次穿越时应能再次提醒。

## 5. 验证脏行情保护

1. 模拟 stale 或断线重连。
2. 确认 stale / placeholder 不触发提醒。
3. 确认重连后的第一笔不会补发提醒。
