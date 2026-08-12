# Pi 实战知识点：从痛点出发

> 前两份深读讲的是 pi 的「架构地图」（agent-loop 心脏 + 会话树记忆 + 扩展插拔）。但地图背得再熟，开车上路还是会撞墙。
>
> 本文反向组织：**先列你会撞的墙（痛点），再讲撞墙后需要的知识点（答案）**。每个痛点对应 3-5 个知识点，配代码/配置/源码出处。
>
> 阅读建议：平时不用硬看。**真撞墙了，翻到对应痛点章节，对照着解决。** 痛过一次的知识点才会长在身上。

---

## 目录

- [痛点 ①：上下文爆了，对话被压没](#痛点-上下文爆了对话被压没)
- [痛点 ②：pi 改错文件想拦截](#痛点-pi-改错文件想拦截)
- [痛点 ③：pi 老忘项目约定](#痛点-pi-老忘项目约定)
- [痛点 ④：/reload 后状态没了](#痛点-reload-后状态没了)
- [附：四痛点的共同心法](#附四痛点的共同心法)

---

## 痛点 ①：上下文爆了，对话被压没

**场景**：你让 pi 改一个项目，改着改着它突然「重新加载」了一下，之后对话历史变短了，前面的细节它不记得了。你慌了：刚才的关键决策是不是丢了？

### 知识点 1：compaction 是什么、何时触发

compaction = **把旧消息压缩成摘要，保留近期消息**，腾出上下文空间。

**自动触发条件**（`compaction.md`）：

```
contextTokens > contextWindow - reserveTokens
```

- `reserveTokens` 默认 16384 —— 给 LLM 响应预留的空间
- 触发后 pi 会恢复并重试（如果是溢出恢复），或主动提前压缩（接近上限时）

**手动触发**：`/compact` 或 `/compact <自定义指令>`（指令可聚焦摘要重点，如「重点保留架构决策」）

### 知识点 2：压缩不是删除，是「摘要 + 保留」二段式

压缩后在会话树里追加一个 `CompactionEntry`，它记录：
- `summary` —— 旧消息的摘要
- `firstKeptEntryId` —— **从哪条消息开始原样保留**
- `tokensBefore` —— 压缩前的 token 数

LLM 实际看到的上下文（`buildSessionContext` 源码，`session.ts:14`）：

```
[system] [summary] [firstKeptEntryId 之后的保留消息] [压缩后的新消息]
                 ↑                      ↑
            来自 cmp 条目        从 firstKeptEntryId 开始
```

**关键**：旧消息**没被删除**，它们还在 JSONL 文件里。只是不再发给 LLM 了。所以「pi 忘了」是假象——它只是没看到，不是真丢了。

### 知识点 3：`firstKeptEntryId` 为什么这么设计

这个字段是整个 compaction 的精髓。设计意图：

1. **切点选择**：从最新消息往回走，累计 token 直到达到 `keepRecentTokens`（默认 20000），那个位置就是切点
2. **切点规则**：只能在 user/assistant/bash/custom 消息上切，**绝不能在 tool 结果上切**（tool 结果必须和它的 tool call 待在一起，否则 LLM 看到孤立的工具结果会困惑）
3. **`firstKeptEntryId` 指向切点**：重建上下文时，从这条开始原样保留，之前的全换成摘要

**为什么用「指针」而不是「删除」**：因为会话是 append-only 的（见会话树深读）。不能删条目，只能记录「从哪开始保留」。这是 append-only 架构下做压缩的必然选择——也是它优雅的地方。

### 知识点 4：split turn —— 单个回合超预算怎么办

一个「turn」= 一条 user 消息 + 后续所有 assistant/tool 直到下一条 user。正常在 turn 边界切。

但如果**单个 turn 就超过 `keepRecentTokens`**（比如你让它读了一个巨大的文件然后做了很多操作），切点会落在这个 turn 中间的 assistant 消息上——这叫 **split turn**。

此时 pi 生成**两个摘要再合并**：
1. 历史摘要（之前的上下文）
2. turn 前缀摘要（这个超大 turn 的前半段）

所以即使单回合爆表，也不会丢。

### 知识点 5：`/tree` 找回被压缩的历史

既然旧消息没删，怎么看？**`/tree`**。

`/tree` 打开会话树浏览器，你能看到所有历史条目（包括被压缩的那些）。压缩点在树里就是一个 `compaction` 节点。你可以跳到压缩前的任何位置继续——那时 LLM 又能看到完整历史了（因为 `buildSessionContext` 会按新分支重建）。

**实操**：感觉 pi「忘了」关键信息时，先别重打。`/tree` 跳回那段历史，要么继续从那里干，要么把关键信息摘出来贴到当前分支。

### 知识点 6：三个配置旋钮

```json
// ~/.pi/agent/settings.json 或 .pi/settings.json
{
  "compaction": {
    "enabled": true,           // 关掉就只能手 /compact
    "reserveTokens": 16384,    // 给响应预留，太小会频繁触发
    "keepRecentTokens": 20000  // 保留的近期量，越大越不易丢但越易爆
  }
}
```

- 频繁触发 → 调大 `reserveTokens` 或换更大上下文窗口的模型
- 老丢关键信息 → 调大 `keepRecentTokens`，或用 `/compact <指令>` 主动控制摘要重点

### 知识点 7：摘要格式是结构化的（不是随便写写）

pi 的摘要用固定模板（`compaction.md`）：

```markdown
## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions
## Next Steps
## Critical Context
<read-files>...</read-files>
<modified-files>...</modified-files>
```

最后两个标签**累积跟踪读/改过的文件**——跨多次压缩也累积。所以压缩后 pi 仍知道「这个项目里我动过哪些文件」，不会重复读。

### 知识点 8：扩展可完全接管压缩

挂 `session_before_compact` 事件，可取消或提供自定义摘要：

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, reason, willRetry } = event;
  // reason: "manual" | "threshold" | "overflow"
  // willRetry: 溢出恢复时是否重试被打断的回合
  return { cancel: true };  // 取消
  // 或自定义摘要：
  return { compaction: { summary: "...", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };
});
```

用 `serializeConversation(convertToLlm(preparation.messagesToSummarize))` 把消息转文本，丢给你的模型生成摘要。

---

## 痛点 ②：pi 改错文件想拦截

**场景**：pi 要 `write` 一个文件，但你不想让它动 `.env`，或者它要执行 `rm -rf` 你想拦下。你想起 permission-gate 那个例子，但不确定怎么精确控制。

### 知识点 1：`tool_call` 事件——拦截的唯一入口

所有工具执行前都会发 `tool_call` 事件（`extensions.md`）。它是**可阻止**的：

```typescript
pi.on("tool_call", async (event, ctx) => {
  // event.toolName  - 工具名
  // event.toolCallId - 调用 ID
  // event.input     - 工具参数（可变！能改参数）
  return { block: true, reason: "..." };  // 阻止，reason 反馈给 LLM
  return undefined;                         // 放行
});
```

**关键时序**：`tool_call` 在 `tool_execution_start` 之后、真正执行之前触发。返回 `{block: true}` 后工具根本不会跑。

### 知识点 2：`event.toolName` 区分工具——精确拦截的基础

内置工具名固定：`read` `bash` `edit` `write` `grep` `find` `ls`。扩展工具用注册时的 `name`。

**只拦 `write` 不拦 `read`**：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "write") return;  // 只关心 write
  // event.input 现在是 { path, content }
  if (event.input.path.endsWith(".env")) {
    return { block: true, reason: "禁止修改 .env" };
  }
});
```

**只拦 `bash` 里的危险命令**：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  if (/\brm\s+-rf\b/.test(event.input.command)) {
    const ok = await ctx.ui.confirm("危险", "允许 rm -rf?");
    if (!ok) return { block: true, reason: "用户拒绝" };
  }
});
```

### 知识点 3：`{block, reason}` 的语义

- `block: true` —— 工具不执行
- `reason` —— **作为工具错误返回给 LLM**。LLM 会看到「这个命令被阻止了，原因是 X」，于是会调整策略（换个命令、或问你）

这就是为什么 permission-gate 不只是「挡住」，而是「挡住并解释」——LLM 能从 reason 学到下次怎么做。

### 知识点 4：`isToolCallEventType` 类型窄化——比 `as` 断言安全

直接 `event.input.command as string` 是危险的（万一不是 bash 工具就崩）。文档推荐：

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // 这里 event.input 自动推断为 { command: string; timeout?: number }
    const cmd = event.input.command;  // 类型安全
  }
  if (isToolCallEventType("read", event)) {
    // event.input 是 { path: string; offset?: number; limit?: number }
  }
});
```

自定义工具的类型窄化需要导出 input 类型：

```typescript
if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
  event.input.action;  // 有类型
}
```

### 知识点 5：`event.input` 可变——能在执行前改参数

不只拦，还能**改**。比如给所有 bash 命令加前缀：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    event.input.command = `source ~/.profile\n${event.input.command}`;
    // 不 return，放行，但参数已被改
  }
});
```

注意：**改了不重新校验**，后续 handler 能看到改动。

### 知识点 6：`tool_result` 是改结果的时机

工具执行**后**会发 `tool_result`（可改结果，不可阻止）：

```typescript
pi.on("tool_result", async (event, ctx) => {
  // event.content / event.details / event.isError 都可改
  return { content: [...], details: {...} };  // 链式 middleware
});
```

用途：给 bash 结果加日志、把 read 的内容脱敏、给工具结果附加元数据。

### 知识点 7：非交互模式怎么办

`ctx.hasUI` 在 print/json 模式为 `false`。这时 `ctx.ui.confirm` 没法弹窗。所以 permission-gate 的写法是：

```typescript
if (isDangerous) {
  if (!ctx.hasUI) {
    return { block: true, reason: "非交互模式，默认阻止" };  // fail-safe
  }
  const ok = await ctx.ui.confirm(...);  // 交互模式才问
  if (!ok) return { block: true, reason: "用户拒绝" };
}
```

**fail-safe 原则**：没 UI 时宁可错杀（阻止），不可错放。

---

## 痛点 ③：pi 老忘项目约定

**场景**：你跟 pi 说「这个项目用 tabs 不用 spaces」「提交前跑 npm test」，它答应了，过几轮就忘。你烦死了，每轮都要重复说。

### 知识点 1：AGENTS.md —— 项目约定的家

pi 启动时自动加载 `AGENTS.md`（或 `CLAUDE.md`），内容**拼进系统提示**，每轮都在。所以放这里的约定 pi 永远不会忘。

**加载位置**（README）：
- `~/.pi/agent/AGENTS.md` —— 全局（所有项目）
- **从 cwd 往上走的所有父目录** —— 项目层级约定
- 当前目录的 `AGENTS.md`

**所有匹配的文件会拼接**。所以你可以：
- 仓库根放总约定
- 子目录放子模块特定约定

例：`F:\AIInfra\pi\AGENTS.md` 会被加载（你那个仓库已经有了，12KB）。

### 知识点 2：加载顺序为什么这么设计

「从 cwd 往上走到根」的设计，是为了**层级覆盖**：

```
/                     AGENTS.md  (公司级通用约定)
  /projects/
    /my-app/          AGENTS.md  (项目级约定)  ← cwd 在这
      /src/           AGENTS.md  (子模块约定)
```

如果在 `src/` 下启动 pi，三个文件都加载，从上到下拼接。子目录的约定可以补充或细化上层。

**为什么 pi 还会「忘」**：如果你把约定**只在对话里说**，不写进 AGENTS.md，那它确实会被 compaction 压缩掉。写进 AGENTS.md 的才在系统提示里，每轮可见。

### 知识点 3：skill —— 按需加载的能力包

约定是「always-on」的（进系统提示）。但有些指令只在特定任务需要（比如「处理 PDF 时用这个脚本」）。这种用 **skill**。

skill 是个含 `SKILL.md` 的目录（`skills.md`）：

```
my-skill/
├── SKILL.md       # frontmatter + 指令
├── scripts/       # 辅助脚本
└── references/    # 详细文档
```

`SKILL.md` 格式：

```markdown
---
name: my-skill
description: 干什么、什么时候用。要具体。  # 这条决定 LLM 何时加载它
---

# My Skill
## Usage
./scripts/process.sh <input>
```

**渐进式披露**（progressive disclosure）：
1. 启动时只扫 `name` + `description`，放进系统提示（很短）
2. 任务匹配时，LLM 用 `read` 读完整 `SKILL.md`
3. 按指令执行，用相对路径调脚本

所以 skill 不占日常上下文，只在需要时加载。

### 知识点 4：skill 的加载位置

- 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`
- 项目（受信任后）：`.pi/skills/`、`.agents/skills/`（从 cwd 往上到 git 根）
- 包：`skills/` 目录或 `package.json` 的 `pi.skills`
- 配置：`settings.json` 的 `skills` 数组
- CLI：`--skill <path>`

**注意**：`.agents/skills/` 是跨工具标准（Claude Code/Codex 也用），所以你能直接复用别人的 skill 仓库。

### 知识点 5：skill 的两种触发方式

1. **自动**：LLM 看到 description 匹配任务，自己 `read` SKILL.md（但模型不一定听话）
2. **强制**：`/skill:name` 命令直接加载并执行

```
/skill:brave-search              # 加载并执行
/skill:pdf-tools extract a.pdf   # 带参数
```

如果 LLM 老不自动用某个 skill，就用 `/skill:name` 强制，或在 AGENTS.md 里写「遇到 X 任务必须用 Y skill」。

### 知识点 6：`.pi/settings.json` 覆盖全局

项目级配置覆盖全局，**嵌套对象合并**（不是整体替换）：

```json
// ~/.pi/agent/settings.json (全局)
{ "compaction": { "enabled": true, "reserveTokens": 16384 } }

// .pi/settings.json (项目)
{ "compaction": { "reserveTokens": 8192 } }

// 结果（合并）
{ "compaction": { "enabled": true, "reserveTokens": 8192 } }
```

所以项目可以只调它关心的那几个字段，不用复制全局配置。

### 知识点 7：SYSTEM.md —— 完全替换系统提示

AGENTS.md 是「附加」。如果你想**完全替换** pi 的默认系统提示，用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）。

只想追加不替换？用 `APPEND_SYSTEM.md`。

CLI 临时覆盖：`--system-prompt "..."` 替换，`--append-system-prompt "..."` 追加。

### 知识点 8：description 写不好 skill 就废了

skill 的 `description` 决定 LLM 何时加载它。**模糊 = 不触发**。

```yaml
# 差：LLM 不知道何时用
description: Helps with PDFs.

# 好：明确触发条件
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

如果 skill 死活不触发，九成是 description 太模糊。

---

## 痛点 ④：/reload 后状态没了

**场景**：你写了个扩展，里面有个 `let items = []` 存数据。用着用着 `/reload`（或自动压缩触发重载），`items` 变空了！你懵了：数据哪去了？

### 知识点 1：内存状态 vs 会话持久化——根本区别

扩展的工厂函数闭包里存的变量是**内存状态**：

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];  // ← 内存状态
  // ...
}
```

`/reload`、`/new`、`/resume`、`/fork`、自动压缩重载——这些都会**销毁旧扩展实例、创建新实例**。新实例的 `items` 又是空的 `[]`。

**这就是「状态没了」的真相**：不是 bug，是扩展实例被重建了。

### 知识点 2：两种持久化路线，选对场景

| 路线 | 存哪 | 适合 | 分支正确？ |
|------|------|------|-----------|
| **工具结果 `details`** | 会话树条目 | 对话相关的状态（todo/notes/计数器） | ✅ 自动 |
| **`appendEntry`** | 会话树条目（custom 类型） | 与对话无关的扩展元数据 | ❌ 需手动处理 |
| **外部文件** | 磁盘 | 跨会话共享、大体积数据 | ❌ 需手动处理 |

`details` 和 `appendEntry` 都进会话树，所以都享受分支正确性（见会话树深读）。**外部文件不享受**——切分支不会回滚文件。

### 知识点 3：`details` 存状态——todo/notes 模式

核心模式（`todo.ts`/`notes.ts`）：

```typescript
let items: string[] = [];  // 内存状态

pi.registerTool({
  name: "my_tool",
  async execute(...) {
    items.push("new");
    return {
      content: [...],                          // 给 LLM
      details: { items: [...items] },          // ← 存全量快照到会话树
    };
  },
});
```

**每次执行都存全量快照**（`[...items]` 浅拷贝，避免引用污染）。

### 知识点 4：`session_start` 重建——把快照读回内存

重载后新实例要恢复状态，挂 `session_start` 扫描当前分支：

```typescript
pi.on("session_start", async (_e, ctx) => {
  items = [];  // 重置
  for (const entry of ctx.sessionManager.getBranch()) {  // 遍历当前分支
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== "my_tool") continue;
    const details = msg.details as { items: string[] } | undefined;
    if (details) items = details.items;  // 每条都覆盖，最后一条就是最新
  }
});
```

**为什么取最后一条就对**：因为每条 details 都是全量快照，最后一条包含所有历史变更的结果。

### 知识点 5：为什么这样能分支正确（回顾会话树深读）

`getBranch()` 返回**当前叶子到根的路径**。`/tree` 切分支后：
- `session_tree` 事件触发 → 重建
- `getBranch()` 返回**新分支**的条目
- `items` 被重建为新分支历史下的状态

**无需任何特殊处理**。这就是把状态存在 `details`（而非外部文件）的最大回报——分支正确性免费送。

### 知识点 6：`session_tree` 也要重建

不只 `session_start`，`/tree` 导航也要重建：

```typescript
pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));  // ← 别忘了
```

漏了 `session_tree`，切分支后状态就是旧的。

### 知识点 7：`appendEntry` —— 不进 LLM 上下文的状态

`details` 会随工具结果发给 LLM（占上下文）。如果状态不该给 LLM 看（比如扩展内部计数、缓存），用 `appendEntry`：

```typescript
pi.appendEntry("my-state", { count: 42 });  // 写入会话树，custom 类型

// 重建
pi.on("session_start", async (_e, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {  // 注意是 getEntries 不是 getBranch
    if (entry.type === "custom" && entry.customType === "my-state") {
      // 从 entry.data 恢复
    }
  }
});
```

注意：`appendEntry` 的条目是 `custom` 类型，`getBranch()` 会包含它但 `buildSessionContext` 不会把它转成消息——所以**不进 LLM 上下文**。

### 知识点 8：哪些变量要重建，哪些不用

判断标准：**这个状态从哪来？**

- 来自工具执行结果 → 存 `details`，`session_start` 重建（todo/notes 模式）
- 来自外部世界（文件、API）→ 重载后重新读取即可，不用持久化
- 纯缓存（可重新计算）→ 不持久化，重载后按需重算
- 跨会话要保留的 → 外部文件

**别什么都持久化**。能重算的就重算，持久化只用于「丢失就真没了」的状态。

### 知识点 9：`session_shutdown` 做清理

重载/切会话前会发 `session_shutdown`，在这里关连接、刷新缓冲：

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason: "quit" | "reload" | "new" | "resume" | "fork"
  connection?.close();
  clearInterval(timer);
});
```

然后在 `session_start` 重新建立。**成对出现**：shutdown 拆，start 建。

---

## 附：四痛点的共同心法

这四个痛点看似无关，其实共享同一个底层逻辑：

### 心法 1：pi 是「无状态循环 + 外部状态」

agent-loop 自己不存状态。状态全在：
- 会话树（对话历史、工具结果、扩展状态）
- 文件系统（项目代码）
- 配置（settings.json、AGENTS.md）

所以任何「状态丢失」问题，本质都是「状态存错地方了」。

### 心法 2：append-only 意味着「永不丢失，只可能看不到」

会话树只追加不删除。所以：
- compaction 不是删除，是不发给 LLM（痛点①）
- 分支不是删除，是换指针（会话树深读）
- `/tree` 能看到一切

「pi 忘了」≈「pi 没看到」，几乎从不是「真丢了」。

### 心法 3：扩展实例是临时的，会话树是永久的

扩展闭包变量随实例生死。会话树条目跨实例存活。所以：
- 重要状态 → 会话树（details / appendEntry）
- 临时状态 → 内存变量
- 重载后 → 从会话树重建（痛点④）

### 心法 4：分层覆盖是 pi 的通用模式

- AGENTS.md：全局 → 父目录 → cwd 拼接（痛点③）
- settings.json：全局 → 项目合并（痛点③）
- 工具：内置可被扩展同名覆盖（痛点②）
- 系统提示：默认 → SYSTEM.md 替换 → APPEND 追加（痛点③）

理解了「上层覆盖下层、同层拼接」这套，大半配置问题迎刃而解。

---

## 痛点 → 知识点速查表

| 痛点 | 核心知识点 | 关键 API/文件 |
|------|-----------|--------------|
| ① 上下文爆了 | compaction 触发条件、firstKeptEntryId、split turn、/tree 找回、3 个旋钮、结构化摘要、扩展接管 | `compaction` 设置、`/compact`、`session_before_compact` |
| ② 改错文件 | tool_call 事件、toolName 区分、{block,reason}、isToolCallEventType、input 可变、tool_result 改结果、hasUI fail-safe | `on("tool_call")`、`on("tool_result")` |
| ③ 老忘约定 | AGENTS.md 层级加载、skill 渐进披露、settings 合并、SYSTEM.md、description 要具体 | `AGENTS.md`、`.pi/skills/`、`settings.json` |
| ④ 状态没了 | 内存 vs 持久化、details 存状态、session_start 重建、session_tree 也要建、appendEntry、shutdown 清理 | `details`、`appendEntry`、`on("session_start")`、`on("session_tree")` |

> 配合阅读：`pi-源码深读-会话树.md`（理解 details 为什么分支正确）、`pi-extensions-学习笔记.md`（todo/notes 实战）、`compaction.md`（压缩完整文档）。
