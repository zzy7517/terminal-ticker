---
description: "在 Spec Kit 命令完成后自动提交修改"
---

# 自动提交修改

在 Spec Kit 命令完成前或完成后，自动 stage 并 commit 当前修改。

## 行为

此命令通常由 hook 触发。它会：

1. 从 hook 上下文判断事件名，例如 `after_specify` 或 `before_plan`。
2. 读取 `.specify/extensions/git/git-config.yml` 的 `auto_commit` 配置。
3. 查找当前事件是否启用自动提交。
4. 如果没有事件专属配置，则回退到 `auto_commit.default`。
5. 优先使用事件配置中的 `message`，否则使用默认提交信息。
6. 如果已启用且存在未提交修改，执行 `git add .` 和 `git commit`。

## 执行

确定触发此命令的事件名，然后运行对应脚本：

- **Bash**：`.specify/extensions/git/scripts/bash/auto-commit.sh <event_name>`
- **PowerShell**：`.specify/extensions/git/scripts/powershell/auto-commit.ps1 <event_name>`

把 `<event_name>` 替换成真实 hook 事件，例如 `after_specify`、`before_plan`、`after_implement`。

## 配置

在 `.specify/extensions/git/git-config.yml` 中配置：

```yaml
auto_commit:
  default: false
  after_specify:
    enabled: true
    message: "[Spec Kit] 新增规格"
  after_plan:
    enabled: false
    message: "[Spec Kit] 新增实施计划"
```

## 降级行为

- 未安装 Git 或当前目录不是 Git 仓库时：给出警告并跳过。
- 配置文件不存在时：跳过，默认不自动提交。
- 没有可提交修改时：跳过并输出提示。
