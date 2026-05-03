---
description: "识别 Git 远端 URL，供 GitHub 集成使用"
---

# 识别 Git 远端 URL

识别当前仓库的 Git 远端 URL，供 GitHub issue 创建等集成使用。

## 前置检查

- 运行 `git rev-parse --is-inside-work-tree 2>/dev/null` 检查 Git 是否可用。
- 如果 Git 不可用，输出警告并返回空结果：

```text
[specify] Warning: Git repository not detected; cannot determine remote URL
```

## 执行

运行以下命令获取远端 URL：

```bash
git config --get remote.origin.url
```

## 输出

解析远端 URL 并判断：

1. **仓库 owner**：从 URL 中提取，例如 `https://github.com/github/spec-kit.git` 中的 `github`。
2. **仓库名**：从 URL 中提取，例如 `https://github.com/github/spec-kit.git` 中的 `spec-kit`。
3. **是否 GitHub**：远端是否指向 GitHub 仓库。

支持的 URL 格式：

- HTTPS：`https://github.com/<owner>/<repo>.git`
- SSH：`git@github.com:<owner>/<repo>.git`

> [!CAUTION]
> 只有远端 URL 确实指向 github.com 时，才报告为 GitHub 仓库。
> URL 格式不匹配时，不要假设它是 GitHub。

## 降级行为

如果未安装 Git、当前目录不是 Git 仓库，或没有配置远端：

- 返回空结果。
- 不报错，让其他工作流继续执行。
