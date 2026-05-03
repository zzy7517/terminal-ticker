---
description: "校验当前分支是否符合功能分支命名约定"
---

# 校验功能分支

检查当前 Git 分支是否符合预期的功能分支命名约定。

## 前置检查

- 运行 `git rev-parse --is-inside-work-tree 2>/dev/null` 检查 Git 是否可用。
- 如果 Git 不可用，输出警告并跳过校验：

```text
[specify] Warning: Git repository not detected; skipped branch validation
```

## 校验规则

获取当前分支名：

```bash
git rev-parse --abbrev-ref HEAD
```

分支名必须匹配以下模式之一：

1. **顺序编号**：`^[0-9]{3,}-`，例如 `001-feature-name`、`042-fix-bug`、`1000-big-feature`
2. **时间戳编号**：`^[0-9]{8}-[0-9]{6}-`，例如 `20260319-143022-feature-name`

## 执行

如果当前是功能分支，也就是匹配任一模式：

- 输出：`✓ On feature branch: <branch-name>`
- 检查 `specs/` 下是否有对应 spec 目录：
  - 顺序编号分支查找 `specs/<prefix>-*`。
  - 时间戳编号分支查找 `specs/<YYYYMMDD-HHMMSS>-*`。
- 如果目录存在，输出：`✓ Spec directory found: <path>`。
- 如果目录不存在，输出：`⚠ No spec directory found for prefix <prefix>`。

如果当前不是功能分支：

- 输出：`✗ Not on a feature branch. Current branch: <branch-name>`。
- 输出：`Feature branches should be named like: 001-feature-name or 20260319-143022-feature-name`。

## 降级行为

如果未安装 Git 或当前目录不是 Git 仓库：

- 检查 `SPECIFY_FEATURE` 环境变量作为回退。
- 如果存在，按同样规则校验它。
- 如果不存在，输出警告并跳过校验。
