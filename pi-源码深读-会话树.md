# Pi 源码深读：会话树（Session Tree）

> 上一篇深读 `agent-loop.ts` 讲了 pi 的「心脏」——LLM↔工具的 while 循环。但那个循环是**无状态**的：它不记得上一轮说了什么。
>
> 状态从哪来？**会话树**。这是 pi 区别于几乎所有同类 agent 的招牌特性：对话不是线性的，而是一棵**持久化到单个 JSONL 文件的树**，分支切换不复制文件、不丢历史。
>
> 本文基于本地源码 `F:\AIInfra\pi` 精读这条链路：
> - `packages/agent/src/harness/session/session.ts`（267 行，会话抽象）
> - `packages/agent/src/harness/session/jsonl-storage.ts`（磁盘存储实现）
> - `packages/agent/src/harness/session/memory-storage.ts`（内存存储实现）
> - `packages/agent/src/harness/types.ts`（`SessionTreeEntry` 联合类型）
> - `packages/coding-agent/src/core/session-manager.ts`（1578 行，上层 API：branch/fork/tree）

---

## 目录

1. [三层架构总览](#三层架构总览)
2. [第一层：条目类型——一棵树长什么样](#第一层条目类型一棵树长什么样)
3. [第二层：SessionStorage 接口——存储抽象](#第二层sessionstorage-接口存储抽象)
4. [第三层：JsonlSessionStorage——树怎么落到磁盘](#第三层jsonlsessionstorage树怎么落到磁盘)
5. [核心算法：getPathToRoot——从叶子走回根](#核心算法getpathtoroot从叶子走回根)
6. [核心算法：buildSessionContext——压缩时怎么重建上下文](#核心算法buildsessioncontext压缩时怎么重建上下文)
7. [分支的真相：branch() 只是改一个指针](#分支的真相branch-只是改一个指针)
8. [LeafEntry：分支切换不复制文件的秘密](#leafentry分支切换不复制文件的秘密)
9. [fork/clone：什么时候才真复制文件](#forkclone什么时候才真复制文件)
10. [为什么这样设计——与 agent-loop 的互补关系](#为什么这样设计与-agent-loop-的互补关系)
11. [可借鉴的设计模式](#可借鉴的设计模式)

---

## 三层架构总览

```
┌─────────────────────────────────────────────────────┐
│  SessionManager  (coding-agent, 1578 行)            │  ← 上层：branch/fork/tree/导航
│  - 面向 TUI 和扩展                                  │
│  - newSession / branch / createBranchedSession ...  │
└────────────────────────┬────────────────────────────┘
                         │ 组合
┌────────────────────────▼────────────────────────────┐
│  Session  (agent 包, session.ts, 267 行)             │  ← 中层：薄封装
│  - appendMessage / appendCompaction / moveTo ...    │
│  - buildContext() = buildSessionContext(getBranch())│
└────────────────────────┬────────────────────────────┘
                         │ 委托
┌────────────────────────▼────────────────────────────┐
│  SessionStorage  (接口)                             │  ← 底层：存储抽象
│  ├─ JsonlSessionStorage  (磁盘，append-only JSONL)  │
│  └─ InMemorySessionStorage (内存，测试/SDK 用)      │
└─────────────────────────────────────────────────────┘
```

**关键分层**：`agent` 包（底层框架）只认 `SessionStorage` 接口，**完全不知道文件系统长什么样**；`coding-agent` 包（产品层）才把磁盘路径、cwd、迁移等业务逻辑拼上去。所以 SDK 用户可以用 `InMemorySessionStorage` 跑一个无文件的 agent，pi 本体用 `JsonlSessionStorage` 持久化。

---

## 第一层：条目类型——一棵树长什么样

`SessionTreeEntry`（`types.ts:409`）是一个**联合类型**，会话文件里的每一行 JSON 都是其中一种：

```typescript
export type SessionTreeEntry =
  | MessageEntry            // 用户/助手/工具消息（对话本体）
  | ThinkingLevelChangeEntry// 思考级别变更
  | ModelChangeEntry        // 模型切换
  | ActiveToolsChangeEntry  // 工具集变更
  | CompactionEntry         // 压缩摘要（旧消息被折叠）
  | BranchSummaryEntry      // 分支摘要（切走时记录被放弃的分支）
  | CustomEntry             // 扩展自定义状态（不进 LLM 上下文）
  | CustomMessageEntry      // 扩展自定义消息（可进 LLM 上下文）
  | LabelEntry              // 标签（书签）
  | SessionInfoEntry        // 会话名等元信息
  | LeafEntry;              // 叶子指针（核心！见后文）
```

**每个条目都带三个字段构成树的骨架**：
- `id: string` —— 自身的唯一 ID（`uuidv7` 前 8 位，时间有序）
- `parentId: string | null` —— 父节点 ID（`null` 表示根）
- `timestamp: string` —— ISO 时间戳

所以会话文件本质是：**一个 append-only 的节点列表，每个节点指向自己的父亲**。树是隐式结构，由 `parentId` 链条构成。

这就是为什么 pi 文档说「每个条目都有 `id` 和 `parentId`，支持 in-place 分支」——分支不是数据结构上的特殊操作，而是**指针的重新连接**。

---

## 第二层：SessionStorage 接口——存储抽象

`SessionStorage`（`types.ts:446`）只暴露 9 个方法，极简：

```typescript
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;              // 当前叶子在哪
  setLeafId(leafId: string | null): Promise<void>;  // 移动叶子（分支！）
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;  // 追加节点
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  findEntries<TType>(type: TType): Promise<Array<...>>; // 按类型查
  getLabel(id: string): Promise<string | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;  // 取当前分支
  getEntries(): Promise<SessionTreeEntry[]>;            // 取全部节点
}
```

**注意三件事**：
1. **没有 `deleteEntry` / `modifyEntry`**——会话是 **append-only** 的。这是整个设计的根基。
2. **没有 `branch()` 方法**——分支就是 `setLeafId()`，移动叶子指针而已。
3. **`getPathToRoot` 是读取的原子操作**——所有「当前对话历史」都从它派生。

`Session` 类（`session.ts:130`）是这个接口的薄封装，提供语义化的 `appendMessage`/`appendCompaction`/`moveTo` 等方法。它本身**不存任何状态**，全部委托给 `storage`：

```typescript
export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
  private storage: SessionStorage<TMetadata>;
  constructor(storage: SessionStorage<TMetadata>) { this.storage = storage; }

  async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
    const leafId = fromId ?? (await this.storage.getLeafId());
    return this.storage.getPathToRoot(leafId);   // ← 委托
  }

  async buildContext(): Promise<SessionContext> {
    return buildSessionContext(await this.getBranch());  // ← 取分支 + 建上下文
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    return this.appendTypedEntry({
      type: "message",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),   // ← 新消息的父亲 = 当前叶子
      timestamp: new Date().toISOString(),
      message,
    });
  }
  // ...
}
```

`appendMessage` 的精髓在 `parentId: await this.storage.getLeafId()`——**新节点总是挂在当前叶子上**。所以「换分支」=「换叶子」=「下一次 append 挂到不同的父亲」，自动形成新分支。

---

## 第三层：JsonlSessionStorage——树怎么落到磁盘

`JsonlSessionStorage`（`jsonl-storage.ts:120`）把树存成 **JSONL 文件**（每行一个 JSON 对象）：

```
第 1 行: session header   {type:"session", version:3, id:..., cwd:..., parentSession?:...}
第 2 行: 条目1            {type:"message", id:"a1", parentId:null, ...}
第 3 行: 条目2            {type:"message", id:"b2", parentId:"a1", ...}
第 4 行: 条目3            {type:"leaf",   id:"c3", parentId:"b2", targetId:"a1"}  ← 分支切换！
第 5 行: 条目4            {type:"message", id:"d4", parentId:"a1", ...}          ← 新分支
...
```

### 内存索引 + 磁盘 append

打开文件时（`open()`，`jsonl-storage.ts:166`），它做两件事：
1. 逐行解析，建三个内存索引：`entries`（顺序数组）、`byId`（id→entry）、`labelsById`（标签缓存）
2. 扫描出 `leafId`：最后一个 `leaf` 条目的 `targetId`，否则最后一个条目的 `id`

```typescript
private entries: SessionTreeEntry[];              // 顺序数组
private byId: Map<string, SessionTreeEntry>;     // id → entry
private labelsById: Map<string, string>;         // targetId → label
private currentLeafId: string | null;            // 当前叶子
```

追加时（`appendEntry`，`jsonl-storage.ts:240`）：**只做两件事——append 一行到文件，更新内存索引**：

```typescript
async appendEntry(entry: SessionTreeEntry): Promise<void> {
  getFileSystemResultOrThrow(
    await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),  // 1) 追加到磁盘
  );
  this.entries.push(entry);                          // 2) 更新内存
  this.byId.set(entry.id, entry);
  updateLabelCache(this.labelsById, entry);
  this.currentLeafId = leafIdAfterEntry(entry);      // 叶子推进
}
```

`leafIdAfterEntry` 是个小巧的函数——只有 `leaf` 类型条目的 `targetId` 才是叶子，其他类型条目的 `id` 本身就是新叶子：

```typescript
function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}
```

---

## 核心算法：getPathToRoot——从叶子走回根

这是整个会话树最核心的读操作。所有「当前对话历史」都从它来。代码极短（`jsonl-storage.ts:262`）：

```typescript
async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
  if (leafId === null) return [];
  const path: SessionTreeEntry[] = [];
  let current = this.byId.get(leafId);
  if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
  while (current) {
    path.unshift(current);                         // 头插，保证根在前
    if (!current.parentId) break;                  // 到根了
    const parent = this.byId.get(current.parentId);
    if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
    current = parent;
  }
  return path;
}
```

**算法**：从叶子出发，沿 `parentId` 链一路向上，直到 `parentId === null`（根）。`unshift` 保证返回顺序是「根→叶子」。

**复杂度**：O(分支深度)。由于 `byId` 是 Map，每步查找 O(1)。

**为什么这个算法是分支正确的**：叶子指针决定了起点，`parentId` 链决定了路径。换叶子 = 换起点 = 换一条从根到叶的路径。**树的所有分支都是这样一条条不相交（但共享前缀）的路径**。

---

## 核心算法：buildSessionContext——压缩时怎么重建上下文

`buildSessionContext`（`session.ts:14`）把一条分支路径转成**真正发给 LLM 的消息序列**。难点在于 **compaction（压缩）**：旧消息被摘要替代，但摘要之后的消息要保留。

```typescript
export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  // 1) 扫描整条路径，收集"当前状态"（思考级别/模型/工具集/最近的压缩）
  let thinkingLevel = "off";
  let model = null;
  let activeToolNames = null;
  let compaction = null;
  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider, modelId };
    else if (entry.type === "message" && entry.message.role === "assistant")
      model = { provider: entry.message.provider, modelId: entry.message.model };
    else if (entry.type === "active_tools_change") activeToolNames = [...entry.activeToolNames];
    else if (entry.type === "compaction") compaction = entry;   // ← 保留最后一个压缩
  }

  // 2) 按压缩点切分，重建消息序列
  const messages: AgentMessage[] = [];
  const appendMessage = (entry) => { /* 把 message/custom_message/branch_summary 转 AgentMessage */ };

  if (compaction) {
    // 有压缩：先放压缩摘要，再放 [firstKeptEntryId, 压缩点) 的保留消息，再放压缩点之后的消息
    messages.push(createCompactionSummaryMessage(compaction.summary, ...));
    const compactionIdx = pathEntries.findIndex(e => e.type === "compaction" && e.id === compaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = pathEntries[i];
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;  // 从这里开始保留
      if (foundFirstKept) appendMessage(entry);
    }
    for (let i = compactionIdx + 1; i < pathEntries.length; i++) appendMessage(pathEntries[i]);
  } else {
    // 无压缩：全部追加
    for (const entry of pathEntries) appendMessage(entry);
  }

  return { messages, thinkingLevel, model, activeToolNames };
}
```

### 三个精妙之处

1. **状态是「最后写入胜」**：`thinkingLevel`/`model`/`activeToolNames` 都在循环里被覆盖，最终值是路径上**最后一个**变更。这意味着切换分支后，模型/思考级别会自动回到那个分支的状态——又是分支正确性。

2. **压缩是「快照 + 增量」**：`CompactionEntry` 记录了 `firstKeptEntryId`（从哪条开始保留）。重建时：摘要 → 保留下来的近期消息 → 压缩后的新消息。旧消息既不在上下文里（省 token），又没丢失（还在文件里，`/tree` 能看）。

3. **`branch_summary` 也是消息**：切分支时被放弃的那条路径可以生成摘要，作为一条 `branch_summary` 消息注入新分支，保留上下文。这避免了「切走就忘」。

---

## 分支的真相：branch() 只是改一个指针

现在看上层 `SessionManager.branch()`（`session-manager.ts:1244`）——**全文件最反直觉的一行**：

```typescript
/**
 * Start a new branch from an earlier entry.
 * Moves the leaf pointer to the specified entry. The next appendXXX() call
 * will create a child of that entry, forming a new branch. Existing entries
 * are not modified or deleted.
 */
branch(branchFromId: string): void {
  if (!this.byId.has(branchFromId)) {
    throw new Error(`Entry ${branchFromId} not found`);
  }
  this.leafId = branchFromId;   // ← 就这一行。没有别的了。
}
```

**分支 = 改一个内存变量**。不写文件，不改任何条目，不复制任何东西。

下一次 `appendMessage` 时，新消息的 `parentId` 就是这个 `branchFromId`，于是新消息成了 `branchFromId` 的**第二个孩子**——树在这里分叉了。

```
假设树结构：
  root(msg1) ── msg2 ── msg3 ── msg4   [当前叶子]

执行 branch("msg2")：leafId 指向 msg2，文件不变
执行 appendMessage(msg5)：msg5.parentId = msg2

树变成：
  root(msg1) ── msg2 ── msg3 ── msg4   （老分支，还在）
                 └── msg5              （新分支，当前叶子）
```

**所有历史都还在文件里**，老分支没丢，只是叶子不指向它了。这就是「in-place 分支不复制文件」的真相。

`resetLeaf()`（`session-manager.ts:1256`）更进一步，把 `leafId = null`，下次 append 会创建新的**根节点**——用于「重新编辑第一条用户消息」。

---

## LeafEntry：分支切换不复制文件的秘密

但 `branch()` 只改内存。如果**关闭程序再打开**，怎么记得当前在哪个分支？答案：`LeafEntry`。

`setLeafId()`（`jsonl-storage.ts:209`）不只是改内存，还会**追加一个 `leaf` 条目到文件**：

```typescript
async setLeafId(leafId: string | null): Promise<void> {
  if (leafId !== null && !this.byId.has(leafId)) {
    throw new SessionError("not_found", `Entry ${leafId} not found`);
  }
  const entry: LeafEntry = {
    type: "leaf",
    id: generateEntryId(this.byId),
    parentId: this.currentLeafId,       // leaf 条目自己也有 parentId 链
    timestamp: new Date().toISOString(),
    targetId: leafId,                    // ← 真正指向的目标
  };
  getFileSystemResultOrThrow(
    await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),  // 写盘
  );
  this.entries.push(entry);
  this.byId.set(entry.id, entry);
  this.currentLeafId = leafId;          // 改内存
}
```

`LeafEntry` 是个**指针条目**：它不是对话内容，只记录「用户把叶子移到了 `targetId`」。重新打开文件时，扫描最后一个 `leaf` 条目就能恢复光标位置（`loadJsonlStorage` 里的 `leafId = leafIdAfterEntry(entry)`）。

**这就是完整的设计**：
- 对话内容条目（message 等）构成树
- `leaf` 条目是「书签」，记录用户当前在看哪个节点
- 分支切换 = 写一个 `leaf` 条目 + 改内存指针
- **零复制、零修改、append-only**

---

## fork/clone：什么时候才真复制文件

`/tree` 是 in-place 分支（同文件）。`/fork` 和 `/clone` 才会创建**新文件**，由 `createBranchedSession()`（`session-manager.ts:1289`）实现：

```typescript
/**
 * Create a new session file containing only the path from root to the specified leaf.
 */
createBranchedSession(leafId: string): string | undefined {
  const previousSessionFile = this.sessionFile;
  const path = this.getBranch(leafId);     // 1) 取出从根到 leafId 的路径
  if (path.length === 0) throw new Error(`Entry ${leafId} not found`);

  // 2) 过滤掉 label 条目（label 是指针，新文件会重建）
  //    同时重新链接 parentId，避免孤儿节点
  const pathWithoutLabels: SessionEntry[] = [];
  let pathParentId: string | null = null;
  for (const entry of path) {
    if (entry.type === "label") continue;
    pathWithoutLabels.push({ ...entry, parentId: pathParentId });  // 重新链接
    pathParentId = entry.id;
  }

  const newSessionId = createSessionId();
  // 3) 新 header，记录 parentSession（指向源文件）
  const header = { type: "session", version, id: newSessionId, cwd, parentSession: previousSessionFile };

  // 4) 收集路径上条目的标签，重建为新的 label 条目
  // 5) 持久化模式下重写一个新文件；内存模式下替换当前
  if (this.persist) {
    this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
    this._rewriteFile();   // ← 真正写一个全新文件
    return newSessionFile;
  }
  // ...
}
```

### 三个关键点

1. **只复制一条路径，不复制整棵树**：`getBranch(leafId)` 只取从根到目标叶子的那条链，其他分支不带走。新文件是一条「拉直」的线性历史。

2. **`parentSession` 字段记录来源**：新文件的 header 里存了源文件路径，形成**会话血缘**。这就是为什么 pi 能在 fork 后追溯「这个会话从哪来」。

3. **label 需要特殊处理**：因为 label 是真实的树节点，后续条目可能挂在 label 上。复制时直接删 label 会断链，所以要「跳过 label 但重新链接 parentId」。这是个容易踩的坑，源码注释也强调了。

### `/fork` vs `/clone` vs `/tree`

| 操作 | 实现 | 文件 | 语义 |
|------|------|------|------|
| `/tree` | `branch()` 改指针 | 同文件 | in-place 探索，保留所有分支 |
| `/fork` | `createBranchedSession(leafId)` + position:"before" | **新文件** | 从某条消息开新会话 |
| `/clone` | `createBranchedSession(leafId)` + position:"at" | **新文件** | 复制当前分支继续干 |

`/tree` 是零成本（一个 leaf 条目）；`/fork`/`/clone` 是 O(分支深度) 成本（写一条线性路径）。

---

## 为什么这样设计——与 agent-loop 的互补关系

把 `agent-loop.ts` 和会话树放一起看，pi 的「极简内核」哲学就完整了：

| 维度 | agent-loop.ts | 会话树 |
|------|---------------|--------|
| 职责 | **计算**：LLM↔工具循环 | **记忆**：持久化状态 |
| 状态 | 无状态纯函数式 | append-only 持久化 |
| 依赖 | 只依赖 config 回调注入 | 只依赖 `SessionStorage` 接口 |
| 复杂度 | 220 行 | ~2000 行（含上层） |

**两者通过 `Session` 桥接**：agent-loop 每轮调 `session.buildContext()` 取当前分支的消息，执行完工具后调 `session.appendMessage()` 追加结果。循环本身不知道有树、有分支、有压缩——它只看到一个消息数组。

**这就是分层解耦的范本**：
- 想换 provider？改 `convertToLlm`（agent-loop 边界）
- 想换存储？实现 `SessionStorage`（会话边界）
- 想加分支策略？在 `SessionManager` 上加方法
- 三者互不污染

---

## 可借鉴的设计模式

### 1. Append-only + 指针 = 不可变历史 + 可变视图

会话文件只追加不修改。所有「修改」（分支、切换、重命名）都是追加一个新条目（`leaf`/`label`/`session_info`）。这是 **event sourcing** 的思想：状态 = 事件序列的 fold。

好处：
- 历史永不丢失（`/tree` 能看所有分支）
- 崩溃恢复简单（重放文件即可）
- 并发安全（只追加）

### 2. 接口隔离：存储抽象让内核与介质解耦

`SessionStorage` 9 个方法，`JsonlSessionStorage` 和 `InMemorySessionStorage` 两个实现。SDK 用户甚至能写自己的存储（比如存数据库）。**内核完全不关心数据在哪**。

### 3. 内存索引 + 磁盘 append 的读写分离

读：内存 Map 索引，O(1) 查找、O(深度) 路径遍历。
写：append 一行 JSONL，O(1)。

写不更新已有数据，所以无需锁、无需事务。这是日志结构存储的典型优势。

### 4. 指针条目（LeafEntry/LabelEntry）与数据条目分离

`leaf` 和 `label` 不承载对话内容，只承载「视图元数据」。把**数据**和**对数据的指向**分开存储，让同一棵树能有多个「当前视图」而不复制数据。

### 5. 类型驱动的设计

`SessionTreeEntry` 是 discriminated union（`type` 字段区分）。`buildSessionContext` 用 `entry.type === "xxx"` 窄化。这是 TypeScript 处理「 heterogeneous 列表」的标准范式，类型安全且可穷举。

---

## 附：源码文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `packages/agent/src/harness/types.ts` | - | `SessionTreeEntry` 联合类型、`SessionStorage` 接口 |
| `packages/agent/src/harness/session/session.ts` | 267 | `Session` 类（薄封装）、`buildSessionContext` |
| `packages/agent/src/harness/session/jsonl-storage.ts` | ~300 | `JsonlSessionStorage`（磁盘实现） |
| `packages/agent/src/harness/session/memory-storage.ts` | ~150 | `InMemorySessionStorage`（内存实现） |
| `packages/coding-agent/src/core/session-manager.ts` | 1578 | `SessionManager`（上层 API：branch/fork/tree/迁移） |
| `packages/coding-agent/docs/session-format.md` | - | 文件格式文档 |

> 配合阅读：`agent-loop.ts`（220 行，pi 的心脏）—— 两者一结合，pi 的「极简内核」全貌就清楚了。
