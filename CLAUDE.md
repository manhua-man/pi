# CLAUDE.md（法 · Protocol）

> 协作协议：本文件回答「在这个仓库里怎么协作」。可核对的事实见 `AGENTS.md` 事层与根 `README.md`；视觉与 TUI 见 `DESIGN.md`。

## Language & Tone

- 与用户同语言；技术表述直接，无 emoji（与上游 `AGENTS.md` Development Rules 一致）。
- 先回答问题，再改代码；对分析类反馈先表明同意或不同意。

## Conflict Resolution

1. 当前轮用户明确指令
2. 根级 `AGENTS.md`（含上游 Development Rules）
3. 本文件 `CLAUDE.md`
4. 根级 `DESIGN.md`（TUI / 产品体验）
5. `steering/*.md`（若有）
6. `.cursor/rules/` 等工具适配层

## Decision Priority

1. Testability
2. Readability
3. Consistency
4. Simplicity
5. Reversibility

## Development Principles

- **Incremental Progress** — 小步、可验证、可回滚
- **Context First** — 改之前读全相关文件
- **Pragmatism Over Dogma** — 项目约束优先于抽象规则
- **Respect Upstream** — 本仓库 fork 自 `earendil-works/pi`；合并 `upstream/main` 前避免无必要改写上游 `AGENTS.md` 正文

## Pi-Specific Protocol

- 核心保持最小；新能力优先 Extension / Skill / Package，见 `CONTRIBUTING.md`。
- 改代码后（非纯文档）：`npm run check`；测试用 `./test.sh`，见 `AGENTS.md` Commands。
- 勿在未获用户要求时 `git add -A`、force push 或 `git reset --hard`（多 session 并行，见 `AGENTS.md` Git）。
- **本 fork 默认用 `-nc` 跑 pi**：`scripts/pi-learn.ps1` / `scripts/pi-learn.sh` 已内置，避免自动加载本仓 `AGENTS.md`/`CLAUDE.md`；需协作规则时用 `-WithContext` 或 `pi-test.sh`。
- 本 fork 学习笔记 `PI-学习指南.md` 非上游权威；上游行为以 `upstream` 与官方文档为准。

## Harness Collaboration

> HARNESS collaboration-principles block

Follow the user's explicit instruction in the current turn first.
Root `AGENTS.md` provides facts and upstream development rules; this file provides collaboration protocol; `DESIGN.md` provides TUI/visual direction.
Third-party workflows only identify, map, and suggest — they never replace the truth layer.
Harness is initialized only via `/harness-init` inside the IDE; never instruct the user to run terminal `harness`, `npm install`, or maintainer TypeScript scripts.
On user `yes`, write only the confirmed Draft bytes directly; do not require Node/npm/npx/tsx or `.harness/runs/` artifacts for onboarding.
Default to incremental merge (`patch-section`) so existing content is preserved.