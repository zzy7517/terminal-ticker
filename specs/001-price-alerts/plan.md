# 实现计划：价格提醒

**Branch**: `001-price-alerts` | **Date**: 2026-04-23 | **Spec**: [spec.md](./spec.md)
**Input**: `/specs/001-price-alerts/spec.md`

## 目标

在现有 watchlist 配置基础上加价格提醒。实现重点是三件事：
- 配置里能定义提醒规则
- 运行时能正确判断“是否真实触发”
- UI 能轻量展示提醒，不破坏原有小窗体验

## 技术上下文

**语言**: Python 3.13  
**依赖**: PySide6, websockets, 标准库  
**存储**: 本地 TOML + 内存状态  
**测试**: `python3 -m unittest discover -s tests`  
**平台**: macOS / Linux 桌面  
**约束**: 不加后端、不加 API key、不自动展开、不允许 stale / reconnect gap 误报

## 设计结论

- 规则放到现有配置里，不新增独立配置系统。
- 提醒状态优先放在 `models.py`，避免 UI 层自己判断业务规则。
- UI 提醒放在 `floating.py`，但保持轻量。
- stale / placeholder / reconnect gap 都视为“不能触发提醒”。

## 改动范围

主要只动这些文件：
- `terminal_ticker/config.py`
- `terminal_ticker/models.py`
- `terminal_ticker/floating.py`
- `tests/test_config.py`
- `tests/test_models.py`
- `tests/test_floating.py`
- `README.md`
- `watchlist.toml`

## 验收重点

- 配置能正确解析提醒规则
- 真实穿越阈值时只提醒一次
- 回到另一侧后可再次提醒
- stale / reconnect gap 不误报
- 折叠状态不自动展开
