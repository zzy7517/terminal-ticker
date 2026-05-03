# Git 分支工作流扩展

这个扩展为 Spec Kit 提供 Git 仓库初始化、功能分支创建、编号、分支校验、远端识别和自动提交能力。

## 概览

扩展把 Git 操作做成独立模块，主要管理：

- **仓库初始化**：可配置初始提交信息。
- **功能分支创建**：支持顺序编号，例如 `001-feature-name`，也支持时间戳编号，例如 `20260319-143022-feature-name`。
- **分支校验**：检查当前分支是否符合命名约定。
- **Git 远端识别**：为 GitHub issue 等集成提供 owner / repo 信息。
- **自动提交**：可在核心 Speckit 命令前后提交修改，并为每个事件配置提交信息。

## 命令

| 命令 | 说明 |
|------|------|
| `speckit.git.initialize` | 初始化 Git 仓库，并使用可配置的初始提交信息 |
| `speckit.git.feature` | 创建顺序编号或时间戳编号的功能分支 |
| `speckit.git.validate` | 校验当前分支是否符合功能分支命名约定 |
| `speckit.git.remote` | 识别 Git 远端 URL，供 GitHub 集成使用 |
| `speckit.git.commit` | 自动提交修改，支持按命令开关和自定义提交信息 |

## 钩子

| 事件 | 命令 | 可选 | 说明 |
|------|------|------|------|
| `before_constitution` | `speckit.git.initialize` | 否 | 初始化宪法前初始化 Git 仓库 |
| `before_specify` | `speckit.git.feature` | 否 | 编写规格前创建功能分支 |
| `before_clarify` | `speckit.git.commit` | 是 | 规格澄清前提交未提交修改 |
| `before_plan` | `speckit.git.commit` | 是 | 计划前提交未提交修改 |
| `before_tasks` | `speckit.git.commit` | 是 | 生成任务前提交未提交修改 |
| `before_implement` | `speckit.git.commit` | 是 | 实现前提交未提交修改 |
| `before_checklist` | `speckit.git.commit` | 是 | 生成检查清单前提交未提交修改 |
| `before_analyze` | `speckit.git.commit` | 是 | 分析前提交未提交修改 |
| `before_taskstoissues` | `speckit.git.commit` | 是 | 同步 issue 前提交未提交修改 |
| `after_constitution` | `speckit.git.commit` | 是 | 宪法更新后自动提交 |
| `after_specify` | `speckit.git.commit` | 是 | 规格生成后自动提交 |
| `after_clarify` | `speckit.git.commit` | 是 | 规格澄清后自动提交 |
| `after_plan` | `speckit.git.commit` | 是 | 计划生成后自动提交 |
| `after_tasks` | `speckit.git.commit` | 是 | 任务生成后自动提交 |
| `after_implement` | `speckit.git.commit` | 是 | 实现后自动提交 |
| `after_checklist` | `speckit.git.commit` | 是 | 检查清单生成后自动提交 |
| `after_analyze` | `speckit.git.commit` | 是 | 分析后自动提交 |
| `after_taskstoissues` | `speckit.git.commit` | 是 | 同步 issue 后自动提交 |

## 配置

配置保存在 `.specify/extensions/git/git-config.yml`：

```yaml
# 分支编号策略："sequential" 或 "timestamp"
branch_numbering: sequential

# git init 后的初始提交信息
init_commit_message: "[Spec Kit] 初始提交"

# 按命令配置自动提交，默认关闭
auto_commit:
  default: false
  after_specify:
    enabled: true
    message: "[Spec Kit] 新增规格"
```

## 安装

```bash
# 安装内置 git 扩展，不需要网络
specify extension add git
```

## 禁用

```bash
# 禁用 git 扩展，spec 创建流程仍会继续
specify extension disable git

# 重新启用
specify extension enable git
```

## 降级行为

当未安装 Git 或当前目录不是 Git 仓库时：

- spec 目录仍会创建在 `specs/` 下。
- 分支创建会跳过并给出警告。
- 分支校验会跳过并给出警告。
- 远端识别会返回空结果。

## 脚本

扩展包含跨平台脚本：

- `scripts/bash/create-new-feature.sh`：Bash 版本的功能分支创建脚本。
- `scripts/bash/git-common.sh`：Bash 共享 Git 工具。
- `scripts/powershell/create-new-feature.ps1`：PowerShell 版本的功能分支创建脚本。
- `scripts/powershell/git-common.ps1`：PowerShell 共享 Git 工具。
