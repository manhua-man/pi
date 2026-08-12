# DESIGN.md（设 · Design）

> TUI 与终端产品体验的设计入口。本仓库是 **终端 Agent Harness**，不是 Web 站点；视觉系统主要体现在交互模式、主题 JSON 与文档插图。

## Design Surface

| 区域 | 路径 | 说明 |
| --- | --- | --- |
| 交互模式 UI | `packages/coding-agent/src/modes/interactive/` | 编辑器、消息区、footer |
| 内置主题 | `packages/coding-agent/src/modes/interactive/theme/` | `dark.json`, `light.json`, schema |
| 主题文档 | `packages/coding-agent/docs/themes.md` | 颜色 token、加载路径、自定义主题 |
| 产品截图 | `packages/coding-agent/docs/images/` | 交互模式示意 |
| 用户主题目录 | `~/.pi/agent/themes/`, `.pi/themes/` | 运行时加载（见 themes 文档） |

## Visual Principles

- **终端优先**：信息密度高、工具输出可折叠；避免 Web 营销式大 hero。
- **主题 token**：颜色通过 JSON theme 定义，不硬编码散落色值；改主题先读 `theme-schema.json`。
- **一致性**：内置 `dark` / `light` 为基准；扩展主题保持 token 命名与 schema 兼容。

## Typography & Color

- 颜色 token 与取值规则见 `packages/coding-agent/docs/themes.md` 的 **Color Tokens** / **Color Values**。
- 语法高亮与 diff 展示见 TUI 渲染链（`packages/tui`、`packages/coding-agent` 工具输出渲染）。

## Change Log

| Date | Change | Notes |
| --- | --- | --- |
| 2026-06-27 | Initial DESIGN entry on fork | Indexes upstream TUI theme system; not a replacement for `docs/themes.md`. |