---
description: "初始化 Git 仓库并创建初始提交"
---

# 初始化 Git 仓库

如果当前项目目录还不是 Git 仓库，则初始化一个 Git 仓库。

## 执行

从项目根目录运行对应脚本：

- **Bash**：`.specify/extensions/git/scripts/bash/initialize-repo.sh`
- **PowerShell**：`.specify/extensions/git/scripts/powershell/initialize-repo.ps1`

如果扩展脚本不存在，使用回退命令：

- **Bash**：`git init && git add . && git commit -m "Initial commit from Specify template"`
- **PowerShell**：`git init; git add .; git commit -m "Initial commit from Specify template"`

脚本内部会处理检查：

- Git 不可用时跳过。
- 已经在 Git 仓库中时跳过。
- 需要初始化时执行 `git init`、`git add .` 和 `git commit`。

## 自定义

可以替换脚本以加入项目自己的初始化步骤：

- 自定义 `.gitignore` 模板。
- 默认分支名配置，例如 `git config init.defaultBranch`。
- Git LFS 初始化。
- Git hooks 安装。
- 提交签名配置。
- Git Flow 初始化。

## 输出

成功时输出：

- `✓ Git repository initialized`

## 降级行为

如果未安装 Git：

- 提醒用户。
- 跳过仓库初始化。
- 项目流程继续可用，spec 仍可创建在 `specs/` 下。

如果 Git 已安装但 `git init`、`git add .` 或 `git commit` 失败：

- 把错误展示给用户。
- 停止当前命令，避免留下半初始化状态。
