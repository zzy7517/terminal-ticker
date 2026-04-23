# 任务拆解：价格提醒

**输入**: `specs/001-price-alerts/` 下的文档  
**前置**: `spec.md`、`plan.md`

**原则**: 只保留真正要做的事，不写样板任务。

## 第一阶段：配置和状态

- [ ] T001 在 `terminal_ticker/config.py` 增加 `alerts` 配置解析和校验
- [ ] T002 在 `tests/test_config.py` 补充合法 / 非法配置测试
- [ ] T003 在 `terminal_ticker/models.py` 增加提醒状态、穿越判断、重新 arm 逻辑
- [ ] T004 在 `tests/test_models.py` 补充穿越、去重、重新 arm、stale 相关测试

## 第二阶段：界面接入

- [ ] T005 在 `terminal_ticker/floating.py` 接入提醒逻辑，展开态能看到提醒
- [ ] T006 在 `terminal_ticker/floating.py` 处理折叠态提醒，且不能自动展开
- [ ] T007 在 `tests/test_floating.py` 补充 UI 提醒、折叠态、重连保护测试

## 第三阶段：文档和验证

- [ ] T008 更新 `README.md` 和 `watchlist.toml` 示例
- [ ] T009 运行 `python3 -m unittest discover -s tests`
- [ ] T010 按 `quickstart.md` 手动验证一遍

## 推荐执行顺序

1. 先做 T001-T004，把“能不能正确判断触发”做稳
2. 再做 T005-T007，把提醒真正挂到 UI 上
3. 最后做 T008-T010，补文档和验收

## 这版任务的边界

- 只做配置文件方式的提醒
- 只做窗口内提醒
- 不做系统通知
- 不做声音
- 不做窗口内编辑器
