# Claude Code project instructions

请读取并严格遵守仓库统一开发与 Git 工作规范：

@AGENTS.md

如果与当前用户明确指令或更具体的安全约束冲突，应遵守优先级更高的要求。不要假定 GitHub 插件已连接；先检查本地 Git 状态和可用权限。

涉及 Commit/Push/PR/CI、后端发布与数据库迁移、产品功能验收时，先使用 `.claude/skills/` 中对应的 Skill（`ci-resource-governance`、`safe-deployment`、`product-delivery`）。
