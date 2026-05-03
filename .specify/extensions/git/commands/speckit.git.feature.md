---
description: "创建顺序编号或时间戳编号的功能分支"
---

# 创建功能分支

为当前规格创建并切换到新的 Git 功能分支。此命令只负责分支创建；spec 目录和文件由核心 `/speckit.specify` 工作流创建。

## 用户输入

```text
$ARGUMENTS
```

如果用户提供了输入，必须先考虑输入内容。

## 环境变量覆盖

如果用户明确提供 `GIT_BRANCH_NAME`，例如通过环境变量、参数或请求文本提供，执行脚本前要把它作为环境变量传入。设置 `GIT_BRANCH_NAME` 后：

- 脚本直接使用该值作为分支名。
- `--short-name`、`--number`、`--timestamp` 标志会被忽略。
- 如果分支名以数字前缀开头，`FEATURE_NUM` 使用该前缀；否则使用完整分支名。

## 前置检查

- 运行 `git rev-parse --is-inside-work-tree 2>/dev/null` 检查 Git 是否可用。
- 如果 Git 不可用，提醒用户并跳过分支创建。

## 分支编号模式

按以下顺序确定分支编号策略：

1. 读取 `.specify/extensions/git/git-config.yml` 的 `branch_numbering`。
2. 读取 `.specify/init-options.json` 的 `branch_numbering`，用于兼容旧配置。
3. 如果都不存在，默认使用 `sequential`。

## 执行

根据功能描述生成 2 到 4 个词的短名称：

- 提取最有意义的关键词。
- 尽量使用动词加名词格式，例如 `add-user-auth`、`fix-payment-bug`。
- 保留 OAuth2、API、JWT 等技术名词。

按平台运行脚本：

- **Bash**：`.specify/extensions/git/scripts/bash/create-new-feature.sh --json --short-name "<short-name>" "<feature description>"`
- **Bash 时间戳模式**：`.specify/extensions/git/scripts/bash/create-new-feature.sh --json --timestamp --short-name "<short-name>" "<feature description>"`
- **PowerShell**：`.specify/extensions/git/scripts/powershell/create-new-feature.ps1 -Json -ShortName "<short-name>" "<feature description>"`
- **PowerShell 时间戳模式**：`.specify/extensions/git/scripts/powershell/create-new-feature.ps1 -Json -Timestamp -ShortName "<short-name>" "<feature description>"`

注意：

- 不要传 `--number`，脚本会自动计算下一个编号。
- 必须带 JSON 标志，Bash 使用 `--json`，PowerShell 使用 `-Json`。
- 每个功能只能运行一次此脚本。
- JSON 输出包含 `BRANCH_NAME` 和 `FEATURE_NUM`。

## 降级行为

如果未安装 Git 或当前目录不是 Git 仓库：

- 跳过分支创建，并输出警告：`[specify] Warning: Git repository not detected; skipped branch creation`
- 脚本仍输出 `BRANCH_NAME` 和 `FEATURE_NUM`，便于后续流程引用。

## 输出

脚本输出 JSON：

- `BRANCH_NAME`：分支名，例如 `003-user-auth` 或 `20260319-143022-user-auth`
- `FEATURE_NUM`：使用的数字或时间戳前缀
