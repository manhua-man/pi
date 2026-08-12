# Pi 扩展（Extensions）学习笔记

> 本文档整理了 7 个 Pi 扩展示例的源码与逐行讲解，按难度递进，覆盖扩展开发的核心概念。
>
> 示例来源：`@earendil-works/pi-coding-agent/examples/extensions/`（前 6 个为官方示例，第 7 个 `notes.ts` 为配套练习）。

---

## 目录

1. [核心概念速览](#核心概念速览)
2. [示例 1：`hello.ts` — 最小工具（地基）](#示例-1hellots-最小工具地基)
3. [示例 2：`permission-gate.ts` — 事件拦截](#示例-2permission-gatets-事件拦截)
4. [示例 3：`commands.ts` — 命令 + 反射 API](#示例-3commandsts-命令--反射-api)
5. [示例 4：`dynamic-tools.ts` — 运行时动态注册](#示例-4dynamic-toolsts-运行时动态注册)
6. [示例 5：`question.ts` — 工具内全自定义 UI](#示例-5questionts-工具内全自定义-ui)
7. [示例 6：`todo.ts` — 有状态工具（完整形态）](#示例-6todots-有状态工具完整形态)
8. [示例 7：`notes.ts` — 综合练习（自写）](#示例-7notests-综合练习自写)
9. [七例横向对比](#七例横向对比)
10. [测试验证记录](#测试验证记录)
11. [附录：关键 API 速查](#附录关键-api-速查)

---

## 核心概念速览

Pi 的扩展是一个 **TypeScript 模块**，导出一个工厂函数，接收 `ExtensionAPI`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("event_name", async (event, ctx) => { /* 监听事件 */ });
  pi.registerTool({ /* 注册工具 */ });
  pi.registerCommand("name", { /* 注册命令 */ });
}
```

**四大能力：**

| 能力 | API |
|------|-----|
| 自定义工具（LLM 可调用） | `pi.registerTool()` |
| 拦截事件（阻止/修改工具调用、注入上下文） | `pi.on(event, handler)` |
| 与用户交互 | `ctx.ui.select/confirm/input/notify` |
| 自定义 UI 组件 | `ctx.ui.custom()` |

**execute 的 5 个参数**（口诀：**id, params, signal, onUpdate, ctx**）：
- `toolCallId` — 调用唯一 ID
- `params` — schema 验证后的参数
- `signal` — AbortSignal（取消）
- `onUpdate` — 流式进度
- `ctx` — ExtensionContext

**返回值双轨制：** `content` 给 LLM 看，`details` 给 UI/状态用。

---

## 示例 1：`hello.ts` — 最小工具（地基）

> 最简单的工具注册。学习工具的基本结构。

### 源码

```typescript
/**
 * Hello Tool - Minimal custom tool example
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(helloTool);
}
```

### 讲解

1. **`defineTool()`**：把工具**定义**和**注册**分离——好处是工具定义可单独导出、复用、单元测试。`todo.ts` 直接把字面量传给 `registerTool`，两者等价。
2. **execute 五参数**：`_toolCallId, params, _signal, _onUpdate, _ctx`（下划线前缀表示未使用）。
3. **返回值双轨**：`content`（发给 LLM）+ `details`（给 UI/状态）。hello 没用上 details，但养成习惯总带上。

### 要点

| 概念 | 说明 |
|------|------|
| `defineTool` | 分离定义与注册，便于复用/测试 |
| execute 五参数 | id, params, signal, onUpdate, ctx |
| content / details | content 给 LLM，details 给 UI/状态 |

---

## 示例 2：`permission-gate.ts` — 事件拦截

> 在工具执行前拦截并询问用户。学习事件拦截模式，仅 30 行，最佳起点。

### 源码

```typescript
/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
```

### 逐行讲解

```typescript
// 1) 定义危险命令的正则模式数组
const dangerousPatterns = [
  /\brm\s+(-rf?|--recursive)/i,   // rm -rf, rm -r
  /\bsudo\b/i,                     // sudo
  /\b(chmod|chown)\b.*777/i,       // chmod/chown 777
];

// 2) 监听 tool_call 事件 —— 这是"可阻止"的事件
pi.on("tool_call", async (event, ctx) => {
  // 3) 只关心 bash 工具，其他工具直接放行（返回 undefined）
  if (event.toolName !== "bash") return undefined;

  // 4) event.input 是工具参数，这里是 { command: string }
  const command = event.input.command as string;
  const isDangerous = dangerousPatterns.some((p) => p.test(command));

  if (isDangerous) {
    // 5) 非交互模式没有 UI，直接阻止（fail-safe 思想）
    if (!ctx.hasUI) {
      return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
    }
    // 6) 弹出选择框，让用户确认
    const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
    // 7) 用户没选"Yes"就阻止；reason 会反馈给 LLM
    if (choice !== "Yes") {
      return { block: true, reason: "Blocked by user" };
    }
  }
  // 8) 放行
  return undefined;
});
```

### 关键概念

| 概念 | 体现 |
|------|------|
| 事件拦截 | `pi.on("tool_call", ...)` |
| 可阻止事件 | 返回 `{ block: true, reason }` |
| 类型窄化 | `event.toolName === "bash"` 后访问 `event.input.command` |
| 模式适配 | `ctx.hasUI` 判断是否非交互模式 |
| 用户交互 | `ctx.ui.select()` 弹选择框 |
| 反馈给 LLM | `reason` 会作为工具错误返回给模型 |

⚠️ 此处用 `as string` 断言。文档推荐的更安全写法：

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
if (isToolCallEventType("bash", event)) {
  const command = event.input.command;  // 自动推断为 string
}
```

---

## 示例 3：`commands.ts` — 命令 + 反射 API

> 演示 `pi.getCommands()` 反射 API 和命令的各种写法。

### 源码

```typescript
/**
 * Commands Extension
 *
 * Demonstrates the pi.getCommands() API by providing a /commands command
 * that lists all available slash commands in the current session.
 */
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export default function commandsExtension(pi: ExtensionAPI) {
	pi.registerCommand("commands", {
		description: "List available slash commands",
		getArgumentCompletions: (prefix) => {
			const sources = ["extension", "prompt", "skill"];
			const filtered = sources.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const commands = pi.getCommands();
			const sourceFilter = args.trim() as "extension" | "prompt" | "skill" | "";

			const filtered = sourceFilter ? commands.filter((c) => c.source === sourceFilter) : commands;

			if (filtered.length === 0) {
				ctx.ui.notify(sourceFilter ? `No ${sourceFilter} commands found` : "No commands found", "info");
				return;
			}

			const formatCommand = (cmd: SlashCommandInfo): string => {
				const desc = cmd.description ? ` - ${cmd.description}` : "";
				return `/${cmd.name}${desc}`;
			};

			const items: string[] = [];
			const sources: Array<{ key: "extension" | "prompt" | "skill"; label: string }> = [
				{ key: "extension", label: "Extensions" },
				{ key: "prompt", label: "Prompts" },
				{ key: "skill", label: "Skills" },
			];

			for (const { key, label } of sources) {
				const cmds = filtered.filter((c) => c.source === key);
				if (cmds.length > 0) {
					items.push(`--- ${label} ---`);
					items.push(...cmds.map(formatCommand));
				}
			}

			const selected = await ctx.ui.select("Available Commands", items);

			if (selected && !selected.startsWith("---")) {
				const cmdName = selected.split(" - ")[0].slice(1);
				const cmd = commands.find((c) => c.name === cmdName);
				if (cmd?.sourceInfo.path) {
					const showPath = await ctx.ui.confirm(cmd.name, `View source path?\n${cmd.sourceInfo.path}`);
					if (showPath) {
						ctx.ui.notify(cmd.sourceInfo.path, "info");
					}
				}
			}
		},
	});
}
```

### 讲解

```typescript
pi.registerCommand("commands", {
  // 1) 参数自动补全：用户输入 /commands <prefix> 时触发
  getArgumentCompletions: (prefix) => {
    const sources = ["extension", "prompt", "skill"];
    const filtered = sources.filter((s) => s.startsWith(prefix));
    return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
  },
  handler: async (args, ctx) => {
    // 2) pi.getCommands() —— 查询当前所有可用命令（扩展/模板/skill）
    const commands = pi.getCommands();
    // 3) 分组构建选项列表
    // 4) ctx.ui.select 弹出选择器
    const selected = await ctx.ui.select("Available Commands", items);
    // 5) 选中后，用 ctx.ui.confirm 二次确认，展示命令源路径
    if (selected && !selected.startsWith("---")) {
      const cmd = commands.find((c) => c.name === cmdName);
      if (cmd?.sourceInfo.path) {
        const showPath = await ctx.ui.confirm(...);
        if (showPath) ctx.ui.notify(cmd.sourceInfo.path, "info");
      }
    }
  },
});
```

### 关键概念

| 概念 | 说明 |
|------|------|
| 命令签名 | `handler: async (args, ctx) => {...}`，`args` 是命令后跟的文本 |
| `getArgumentCompletions` | 可选，返回补全项数组或 `null`；Tab 触发 |
| `pi.getCommands()` | 反射 API，返回 `{ name, description, source, sourceInfo }` |
| `source` | `"extension" \| "prompt" \| "skill"` |
| `sourceInfo` | 命令来源元信息（路径、作用域、是否来自 package）——文档强调用 sourceInfo 判断归属 |
| UI 串联 | `select` → `confirm` → `notify`，可链式组合 |

---

## 示例 4：`dynamic-tools.ts` — 运行时动态注册

> 工具可在 `session_start` 后、命令里动态注册，无需 `/reload`。

### 源码

```typescript
/**
 * Dynamic Tools Extension
 *
 * Demonstrates registering tools after session initialization.
 * - Registers one tool during session_start
 * - Registers additional tools at runtime via /add-echo-tool <name>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ECHO_PARAMS = Type.Object({
	message: Type.String({ description: "Message to echo" }),
});

function normalizeToolName(input: string): string | undefined {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) return undefined;
	if (!/^[a-z0-9_]+$/.test(trimmed)) return undefined;
	return trimmed;
}

export default function dynamicToolsExtension(pi: ExtensionAPI) {
	const registeredToolNames = new Set<string>();

	const registerEchoTool = (name: string, label: string, prefix: string): boolean => {
		if (registeredToolNames.has(name)) {
			return false;
		}

		registeredToolNames.add(name);
		pi.registerTool({
			name,
			label,
			description: `Echo a message with prefix: ${prefix}`,
			promptSnippet: `Echo back user-provided text with ${prefix.trim()} prefix`,
			promptGuidelines: ["Use echo_session when the user asks for exact echo output."],
			parameters: ECHO_PARAMS,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `${prefix}${params.message}` }],
					details: { tool: name, prefix },
				};
			},
		});

		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		registerEchoTool("echo_session", "Echo Session", "[session] ");
		ctx.ui.notify("Registered dynamic tool: echo_session", "info");
	});

	pi.registerCommand("add-echo-tool", {
		description: "Register a new echo tool dynamically: /add-echo-tool <tool_name>",
		handler: async (args, ctx) => {
			const toolName = normalizeToolName(args);
			if (!toolName) {
				ctx.ui.notify("Usage: /add-echo-tool <tool_name> (lowercase, numbers, underscores)", "warning");
				return;
			}

			const created = registerEchoTool(toolName, `Echo ${toolName}`, `[${toolName}] `);
			if (!created) {
				ctx.ui.notify(`Tool already registered: ${toolName}`, "warning");
				return;
			}

			ctx.ui.notify(`Registered dynamic tool: ${toolName}`, "info");
		},
	});
}
```

### 讲解

```typescript
// 1) 工厂函数：根据参数注册一个 echo 工具
const registerEchoTool = (name, label, prefix): boolean => {
  if (registeredToolNames.has(name)) return false;  // 已注册则跳过
  registeredToolNames.add(name);
  pi.registerTool({
    name, label,
    description: `Echo a message with prefix: ${prefix}`,
    promptSnippet: `Echo back user-provided text with ${prefix.trim()} prefix`,  // 进系统提示
    promptGuidelines: ["Use echo_session when the user asks for exact echo output."],
    parameters: ECHO_PARAMS,
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `${prefix}${params.message}` }], details: { tool: name, prefix } };
    },
  });
  return true;
};

// 2) 启动时注册一个
pi.on("session_start", (_event, ctx) => {
  registerEchoTool("echo_session", "Echo Session", "[session] ");
  ctx.ui.notify("Registered dynamic tool: echo_session", "info");
});

// 3) 用户命令动态添加更多
pi.registerCommand("add-echo-tool", {
  handler: async (args, ctx) => {
    const toolName = normalizeToolName(args);
    if (!toolName) { ctx.ui.notify("Usage: ...", "warning"); return; }
    const created = registerEchoTool(toolName, `Echo ${toolName}`, `[${toolName}] `);
    ctx.ui.notify(created ? `Registered: ${toolName}` : `Already registered: ${toolName}`, ...);
  },
});
```

### 关键概念

| 概念 | 说明 |
|------|------|
| 动态注册 | `pi.registerTool()` 不只能在工厂里调用，事件处理器、命令里都行，立即生效 |
| `promptSnippet` | 一句话描述，进系统提示的 "Available tools" 区 |
| `promptGuidelines` | 工具专属准则，只在工具激活时加入。⚠️ 必须写明工具名（"Use echo_session when..."），准则会被扁平拼接 |
| 去重 | 用 `Set` 防止重复注册同名工具 |
| 输入校验 | `normalizeToolName` 用正则校验，给用户友好提示 |

---

## 示例 5：`question.ts` — 工具内全自定义 UI

> 演示工具执行中如何阻塞等待用户输入。核心是 `ctx.ui.custom()`。

### 源码

```typescript
/**
 * Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "Type something..."
 * Escape in editor returns to options, Escape in options cancels
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			const allOptions: DisplayOption[] = [...params.options, { label: "Type something.", isOther: true }];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));

						add(theme.fg("accent", "─".repeat(width)));
						add(theme.fg("text", ` ${params.question}`));
						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";

							if (isOther && editMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else if (selected) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`));
							} else {
								add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
							}

							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}

						if (editMode) {
							lines.push("");
							add(theme.fg("muted", " Your answer:"));
							for (const line of editor.render(width - 2)) {
								add(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							add(theme.fg("dim", " Enter to submit • Esc to go back"));
						} else {
							add(theme.fg("dim", " ↑↓ navigate • Enter to select • Esc to cancel"));
						}
						add(theme.fg("accent", "─".repeat(width)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			const simpleOptions = params.options.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
```

### 讲解：`ctx.ui.custom()` 三件套

`ctx.ui.custom()` 的回调必须返回一个对象，实现这三个方法：

| 方法 | 作用 |
|------|------|
| `render(width): string[]` | 返回每一行的字符串（可含 ANSI 颜色），按宽度截断 |
| `handleInput(data: string)` | 处理按键（用 `matchesKey(data, Key.enter)` 判断） |
| `invalidate()` | 清缓存，强制下次 render 重算 |

`done(value)` 是退出信号，`value` 就是 `await ctx.ui.custom<T>()` 的返回值。

### 三个进阶技巧

1. **缓存渲染**：`cachedLines` 模式——只在 invalidate 时清空，避免每次按键重算。
2. **组合 Editor**：在自定义组件里内嵌 `new Editor(tui, theme)`，实现"选项 + 自由输入"混合交互。
3. **模式切换**：用 `editMode` 布尔值在"选项模式"和"编辑模式"间切换。

⚠️ 用到 `@earendil-works/pi-tui` 的 `Editor`、`Key`、`matchesKey`、`Text`、`truncateToWidth`——做复杂 UI 时这些是基础积木。

---

## 示例 6：`todo.ts` — 有状态工具（完整形态）

> 演示扩展最完整的形态：工具 + 命令 + 状态持久化 + 自定义渲染 + UI 组件。

### 源码

```typescript
/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const done = this.todos.filter((t) => t.done).length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.done = !todo.done;
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// Register the /todos command for users
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
```

### 分块讲解

#### 块 1：类型定义与参数 schema

```typescript
interface Todo { id: number; text: string; done: boolean; }
interface TodoDetails { action: "list"|"add"|"toggle"|"clear"; todos: Todo[]; nextId: number; error?: string; }

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});
```

**核心思想**：`TodoDetails` 既是工具结果的 `details`，也是持久化到会话的状态载体。

- 用 `StringEnum` 而非 `Type.Union/Type.Literal` —— Google API 不兼容后者
- `as const` 让 `StringEnum` 推断字面量类型，`params.action` 才能在 switch 里窄化

#### 块 2：状态重建（理解分支正确性的关键）

```typescript
let todos: Todo[] = [];
let nextId = 1;

const reconstructState = (ctx: ExtensionContext) => {
  todos = [];
  nextId = 1;
  for (const entry of ctx.sessionManager.getBranch()) {  // 遍历当前分支
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
    const details = msg.details as TodoDetails | undefined;
    if (details) {
      todos = details.todos;   // 直接用最后一次结果（已含全部历史）
      nextId = details.nextId;
    }
  }
};

pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
```

💡 **这是 pi 状态管理的精髓**：状态存在 `details` 里，分支切换时自动重建 → **不同分支有各自正确的 todo 状态**，不需要外部文件。这就是文档说的 "proper branching support"。

#### 块 3：工具 execute（业务逻辑）

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
  switch (params.action) {
    case "add": {
      const newTodo: Todo = { id: nextId++, text: params.text!, done: false };
      todos.push(newTodo);
      return {
        content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
        details: { action: "add", todos: [...todos], nextId } as TodoDetails,  // ← 关键：每次都存全量
      };
    }
    // ... toggle/clear/list 类似
  }
}
```

⚠️ 每次返回都 `todos: [...todos]`（存全量快照），所以重建时只需取最后一条结果。

#### 块 4：自定义渲染

```typescript
renderCall(args, theme, _context) {
  // 渲染工具调用行：todo add "买菜"
  let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
  if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
  return new Text(text, 0, 0);
},
renderResult(result, { expanded }, theme, _context) {
  const details = result.details as TodoDetails | undefined;
  if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
  // 根据 action 渲染不同样式，expanded 时显示更多
}
```

要点：`renderCall` 渲染调用头，`renderResult` 渲染结果，都用 `theme.fg()` 上色，返回 `Text` 组件。

#### 块 5：用户命令 + 自定义 UI 组件

```typescript
pi.registerCommand("todos", {
  handler: async (_args, ctx) => {
    if (!ctx.hasUI) { ctx.ui.notify("...", "error"); return; }
    // ctx.ui.custom 临时用自定义组件替换编辑器，直到 done() 被调用
    await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
      return new TodoListComponent(todos, theme, () => done());
    });
  },
});
```

`TodoListComponent` 实现了 `handleInput`、`render`、`invalidate` 三个方法——这是自定义组件的标准接口。

---

## 示例 7：`notes.ts` — 综合练习（自写）

> 综合运用前 6 例的技巧：工具 + 命令 + 状态持久化 + 自定义渲染 + UI 组件。对标 todo.ts 但更简洁。

### 源码

```typescript
/**
 * Notes Extension — 极简笔记工具（学习用，对标 todo.ts 但更简洁）
 *
 * 功能：
 * - 注册 `notes` 工具，LLM 可调用：add / list / remove / clear
 * - 注册 `/notes` 命令，用户可打开查看界面
 *
 * 状态管理：
 * - 笔记存在工具结果的 `details` 里（不是外部文件）
 * - 这样会话分支切换时，笔记状态自动正确（proper branching）
 *
 * 对照 todo.ts 学习：结构完全一致，只是去掉了 toggle，简化了渲染。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─────────────────────────────────────────────────────────────
// 1. 类型定义
// ─────────────────────────────────────────────────────────────

/** 单条笔记 */
interface Note {
	id: number;
	text: string;
}

/**
 * 工具结果的 details 类型。
 * 关键：每次执行都把【全量】笔记存进来，重建状态时只需取最后一条结果。
 */
interface NoteDetails {
	action: "add" | "list" | "remove" | "clear";
	notes: Note[];
	nextId: number;
	error?: string;
}

// ─────────────────────────────────────────────────────────────
// 2. 工具参数 schema
// ─────────────────────────────────────────────────────────────

const NoteParams = Type.Object({
	action: StringEnum(["add", "list", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "笔记内容（add 时必填）" })),
	id: Type.Optional(Type.Number({ description: "笔记 ID（remove 时必填）" })),
});

// ─────────────────────────────────────────────────────────────
// 3. /notes 查看界面组件（精简版自定义组件）
// ─────────────────────────────────────────────────────────────

class NotesViewComponent {
	private notes: Note[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(notes: Note[], theme: Theme, onClose: () => void) {
		this.notes = notes;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		// Escape 或 Ctrl+C 关闭
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		// 宽度没变就用缓存，避免重复计算
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];
		lines.push("");

		// 标题栏
		const title = th.fg("accent", " Notes ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.notes.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "还没有笔记。让 agent 帮你记一条吧！")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", `共 ${this.notes.length} 条笔记`)}`, width));
			lines.push("");
			for (const note of this.notes) {
				const id = th.fg("accent", `#${note.id}`);
				const text = th.fg("text", note.text);
				lines.push(truncateToWidth(`  ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "按 Escape 关闭")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─────────────────────────────────────────────────────────────
// 4. 扩展主入口
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// 内存状态（从会话重建）
	let notes: Note[] = [];
	let nextId = 1;

	/**
	 * 从当前会话分支重建状态。
	 * 扫描所有 notes 工具结果，取最后一条的 details（它包含全量快照）。
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		notes = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "notes") continue;
			const details = msg.details as NoteDetails | undefined;
			if (details) {
				notes = details.notes;
				nextId = details.nextId;
			}
		}
	};

	// 会话开始 / 树导航时重建状态
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// ───────────────────────────────────────────────────────────
	// 4.1 注册 notes 工具（LLM 可调用）
	// ───────────────────────────────────────────────────────────
	pi.registerTool({
		name: "notes",
		label: "Notes",
		description: "管理一个笔记列表。动作：add (text), list, remove (id), clear",
		parameters: NoteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: notes.length
									? notes.map((n) => `#${n.id}: ${n.text}`).join("\n")
									: "No notes",
							},
						],
						details: { action: "list", notes: [...notes], nextId } as NoteDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: add 需要 text" }],
							details: { action: "add", notes: [...notes], nextId, error: "text required" } as NoteDetails,
						};
					}
					const newNote: Note = { id: nextId++, text: params.text };
					notes.push(newNote);
					return {
						content: [{ type: "text", text: `Added note #${newNote.id}: ${newNote.text}` }],
						details: { action: "add", notes: [...notes], nextId } as NoteDetails,
					};
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: remove 需要 id" }],
							details: { action: "remove", notes: [...notes], nextId, error: "id required" } as NoteDetails,
						};
					}
					const idx = notes.findIndex((n) => n.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `Note #${params.id} not found` }],
							details: {
								action: "remove",
								notes: [...notes],
								nextId,
								error: `#${params.id} not found`,
							} as NoteDetails,
						};
					}
					const removed = notes.splice(idx, 1)[0];
					return {
						content: [{ type: "text", text: `Removed note #${removed.id}: ${removed.text}` }],
						details: { action: "remove", notes: [...notes], nextId } as NoteDetails,
					};
				}

				case "clear": {
					const count = notes.length;
					notes = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} notes` }],
						details: { action: "clear", notes: [], nextId: 1 } as NoteDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							notes: [...notes],
							nextId,
							error: `unknown action: ${params.action}`,
						} as NoteDetails,
					};
			}
		},

		// 渲染工具调用行：notes add "记得买牛奶"
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("notes ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		// 渲染工具结果
		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as NoteDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			switch (details.action) {
				case "list": {
					if (details.notes.length === 0) {
						return new Text(theme.fg("dim", "No notes"), 0, 0);
					}
					let listText = theme.fg("muted", `${details.notes.length} note(s):`);
					const display = expanded ? details.notes : details.notes.slice(0, 5);
					for (const n of display) {
						listText += `\n${theme.fg("accent", `#${n.id}`)} ${theme.fg("muted", n.text)}`;
					}
					if (!expanded && details.notes.length > 5) {
						listText += `\n${theme.fg("dim", `... 还有 ${details.notes.length - 5} 条`)}`;
					}
					return new Text(listText, 0, 0);
				}
				case "add": {
					const added = details.notes[details.notes.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}
				case "remove":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Removed"), 0, 0);
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all notes"), 0, 0);
			}
		},
	});

	// ───────────────────────────────────────────────────────────
	// 4.2 注册 /notes 命令（用户查看）
	// ───────────────────────────────────────────────────────────
	pi.registerCommand("notes", {
		description: "查看当前分支的所有笔记",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/notes 需要交互模式", "error");
				return;
			}
			// ctx.ui.custom: 临时用自定义组件替换编辑器，直到 done() 被调用
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new NotesViewComponent(notes, theme, () => done());
			});
		},
	});
}
```

### 逐块讲解

#### 块 1：类型定义与 schema

```typescript
interface Note { id: number; text: string; }
interface NoteDetails { action: "add"|"list"|"remove"|"clear"; notes: Note[]; nextId: number; error?: string; }

const NoteParams = Type.Object({
  action: StringEnum(["add", "list", "remove", "clear"] as const),
  text: Type.Optional(Type.String({ description: "..." })),
  id: Type.Optional(Type.Number({ description: "..." })),
});
```

**核心思想**：`NoteDetails` 是双用途的——既是工具返回的 `details`（给 UI 渲染），也是**持久化到会话的状态载体**（给重建用）。

- 用 `StringEnum` 而非 `Type.Union/Type.Literal` —— Google API 不兼容后者
- `as const` 让 `StringEnum` 推断字面量类型，`params.action` 才能在 switch 里窄化

#### 块 2：查看界面组件 `NotesViewComponent`

`ctx.ui.custom()` 要求的"三件套"组件（render / handleInput / invalidate）精简版：

```typescript
class NotesViewComponent {
  handleInput(data) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }
  render(width) {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;  // 缓存
    // 构建标题栏 + 笔记列表 + 底部提示
    ...
    this.cachedLines = lines;
    return lines;
  }
  invalidate() { this.cachedWidth = undefined; this.cachedLines = undefined; }
}
```

**三个要点**：
1. **缓存模式**：`cachedWidth`/`cachedLines` 只在宽度变化或 invalidate 时重算（todo、question 都用此模式）。
2. **`render(width)` 返回 `string[]`**：每个元素是一行，可含 `theme.fg()` 的 ANSI 颜色码。用 `truncateToWidth` 防超宽。
3. **`onClose` 回调**：组件不直接调 `done()`，而是通过构造时传入的 `onClose` 触发——解耦组件和 `ctx.ui.custom` 的生命周期。

#### 块 3：状态重建（整个扩展的精髓）

```typescript
let notes: Note[] = [];
let nextId = 1;

const reconstructState = (ctx: ExtensionContext) => {
  notes = [];
  nextId = 1;
  for (const entry of ctx.sessionManager.getBranch()) {   // 遍历当前分支
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== "notes") continue;
    const details = msg.details as NoteDetails | undefined;
    if (details) {
      notes = details.notes;   // 直接用最后一条的全量快照
      nextId = details.nextId;
    }
  }
};

pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
```

**为什么能保证分支正确？** 关键链路：
1. 每次 `execute` 都返回 `notes: [...notes]` —— **存全量快照**
2. 重建时遍历 `getBranch()`（当前分支），每条 notes 结果都覆盖 `notes`
3. 因为每条都是全量，最后一条就是最新状态

用 `/tree` 切到另一分支时，`session_tree` 触发重建，`getBranch()` 返回**新分支**条目，笔记自动变成那个分支的历史状态。**无需特殊处理**——这就是把状态存在 details 里（而非外部文件）的回报。

`session_start` 覆盖：启动、`/new`、`/resume`、`/fork`、`/reload` 五种场景。

#### 块 4：工具 execute（add / list / remove / clear）

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
  switch (params.action) {
    case "add": {
      if (!params.text) { /* 报错：返回带 error 的 details */ }
      const newNote: Note = { id: nextId++, text: params.text };
      notes.push(newNote);
      return {
        content: [...],
        details: { action: "add", notes: [...notes], nextId },  // ← 存全量
      };
    }
    // remove / list / clear 类似
  }
}
```

**三个要点**：
1. **错误处理方式**：用"返回带 `error` 字段的 details"，而非 `throw`。区别：
   - `throw` → 标记 `isError: true`，LLM 看到是错误
   - 返回 error → 不算错误，只是渲染时显示红字
2. **`[...notes]` 浅拷贝**：每次存快照都展开复制，避免存同一数组引用（否则后续修改会污染历史快照）。
3. **`nextId` 只增不减**：remove 不回收 id，避免老分支 id 混乱。clear 才重置为 1。

#### 块 5：自定义渲染

```typescript
renderCall(args, theme, _context) {
  let text = theme.fg("toolTitle", theme.bold("notes ")) + theme.fg("muted", args.action);
  if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
  return new Text(text, 0, 0);   // padding (0,0)，外层 Box 管边距
},
renderResult(result, { expanded }, theme, _context) {
  if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
  // expanded 时显示全部，否则前 5 条
  const display = expanded ? details.notes : details.notes.slice(0, 5);
  ...
}
```

- 两个渲染函数都返回 `new Text(text, 0, 0)`——padding `(0,0)`，外层默认 Box 处理边距背景
- `expanded` 对应 `Ctrl+O` 展开/折叠，做"默认紧凑、展开详细"的渐进式展示
- 颜色语义：`success`(绿)/`error`(红)/`accent`(强调)/`muted`(次级)/`dim`(三级)

#### 块 6：`/notes` 命令

```typescript
pi.registerCommand("notes", {
  handler: async (_args, ctx) => {
    if (!ctx.hasUI) { ctx.ui.notify("/notes 需要交互模式", "error"); return; }
    await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
      return new NotesViewComponent(notes, theme, () => done());
    });
  },
});
```

- `ctx.hasUI` 守卫：print/json 模式没 UI，先挡掉
- `ctx.ui.custom` 临时替换编辑器为组件，`done()` 退出

---

## 七例横向对比

| 例子 | 模式 | 核心学到 | 复杂度 |
|------|------|----------|--------|
| `hello.ts` | 最小工具 | `defineTool` + execute 五参数 + content/details 双轨 | ⭐ |
| `permission-gate.ts` | 事件拦截 | `on("tool_call")` + `{block, reason}` + `ctx.hasUI` | ⭐ |
| `commands.ts` | 命令 + 反射 | `registerCommand` + `getCommands` + `sourceInfo` + UI 串联 | ⭐⭐ |
| `dynamic-tools.ts` | 运行时注册 | 动态 `registerTool` + `promptSnippet/Guidelines` | ⭐⭐ |
| `question.ts` | 工具内全自定义 UI | `ctx.ui.custom` 三件套 + Editor 组合 + 模式切换 | ⭐⭐⭐ |
| `todo.ts` | 有状态工具 | `details` 存状态 + 分支重建 + `renderCall/Result` | ⭐⭐⭐⭐ |
| `notes.ts` | 综合练习 | 工具 + 命令 + 状态 + 渲染 + UI 组件 | ⭐⭐⭐⭐ |

### 概念对照（todo.ts vs notes.ts）

| 概念 | todo.ts 位置 | notes.ts 位置 |
|------|-------------|---------------|
| 类型 + schema | 顶部 | 块 1 |
| 自定义组件 | `TodoListComponent` | `NotesViewComponent`（块 2） |
| 状态重建 | `reconstructState` | 块 3 |
| 工具 execute | switch 4 分支 | 块 4（去掉 toggle，加 remove） |
| 渲染 | `renderCall/Result` | 块 5 |
| 命令 | `/todos` | `/notes`（块 6） |

---

## 测试验证记录

`notes.ts` 已通过端到端自动化测试（JSON 模式 + GLM-5.2 模型）：

### 测试 1：扩展加载 + 连接
```
pi --mode json -p "只回复：ok" --no-session
```
✅ 扩展加载无错误，LLM 连接正常，JSON 事件流正常。

### 测试 2：工具调用（add + list）
```
pi --mode json -p "请调用 notes 工具：先 add text=测试笔记ABC，再 list" --no-session
```
✅ 两次工具调用均成功：

| 验证项 | 结果 |
|--------|------|
| 扩展加载 | ✅ 无错误 |
| 工具注册成功 | ✅ LLM 看到了 notes 工具 |
| LLM 能调用 | ✅ 正确传参（action/text） |
| `add` 业务逻辑 | ✅ id 自增到 1，nextId=2 |
| `details` 存全量快照 | ✅ `notes:[{id:1,...}]` |
| 状态在多次调用间保持 | ✅ list 时能读到 add 写入的笔记 |
| 中文处理 | ✅ "测试笔记ABC" 正常 |

### 待手动验证（交互模式）

1. **`/notes` 命令 + 自定义渲染**：`/notes` 弹出查看界面，Escape 关闭
2. **分支状态正确性**：`/tree` 切换分支后 `/notes` 显示对应分支的笔记状态

---

## 附录：关键 API 速查

### ExtensionAPI 方法

| 方法 | 作用 |
|------|------|
| `pi.on(event, handler)` | 订阅事件 |
| `pi.registerTool(definition)` | 注册工具 |
| `pi.registerCommand(name, options)` | 注册命令 |
| `pi.registerShortcut(shortcut, options)` | 注册快捷键 |
| `pi.registerFlag(name, options)` | 注册 CLI flag |
| `pi.registerProvider(name, config)` | 注册 provider |
| `pi.registerMessageRenderer(customType, renderer)` | 自定义消息渲染 |
| `pi.sendMessage(message, options?)` | 注入自定义消息 |
| `pi.sendUserMessage(content, options?)` | 发送用户消息 |
| `pi.appendEntry(customType, data?)` | 持久化扩展状态 |
| `pi.exec(command, args, options?)` | 执行 shell 命令 |
| `pi.getCommands()` | 查询可用命令 |
| `pi.getActiveTools() / getAllTools() / setActiveTools(names)` | 管理工具 |
| `pi.events` | 扩展间事件总线 |

### ctx.ui 方法

| 方法 | 作用 |
|------|------|
| `ctx.ui.select(title, items)` | 选择框 |
| `ctx.ui.confirm(title, message)` | 确认框 |
| `ctx.ui.input(title, placeholder)` | 文本输入 |
| `ctx.ui.editor(title, prefilled)` | 多行编辑 |
| `ctx.ui.notify(message, level)` | 通知（info/warning/error） |
| `ctx.ui.custom(callback)` | 全屏自定义组件 |
| `ctx.ui.setStatus(key, text)` | 底部状态 |
| `ctx.ui.setWidget(key, lines)` | 编辑器上方/下方 widget |
| `ctx.ui.setFooter(renderer)` | 自定义 footer |
| `ctx.ui.setEditorText(text)` | 设置编辑器文本 |
| `ctx.ui.setEditorComponent(factory)` | 自定义编辑器 |

### 核心事件

| 事件 | 可阻止 | 说明 |
|------|--------|------|
| `session_start` | - | 会话开始/加载/重载 |
| `session_shutdown` | - | 扩展运行时销毁前 |
| `session_before_switch/fork/compact/tree` | ✅ 可取消 | 会话操作前 |
| `before_agent_start` | - | 用户提交后、agent 循环前（可改系统提示） |
| `context` | - | 每次 LLM 调用前（可改消息） |
| `tool_call` | ✅ 可阻止 | 工具执行前 |
| `tool_result` | - 可改 | 工具执行后 |
| `input` | ✅ 可拦截/转换 | 用户输入处理前 |
| `model_select` | - | 模型变更 |
| `user_bash` | ✅ 可拦截 | 用户 `!`/`!!` 命令 |

### 工具定义结构

```typescript
pi.registerTool({
  name, label, description,
  promptSnippet,            // 进系统提示 Available tools
  promptGuidelines,         // 进系统提示 Guidelines（须写明工具名）
  parameters: Type.Object({...}),   // typebox schema
  prepareArguments(args) { /* 旧会话兼容 */ },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [...], details: {...}, terminate: true? };
  },
  renderCall(args, theme, context) { /* 调用头渲染 */ },
  renderResult(result, options, theme, context) { /* 结果渲染 */ },
});
```

### 主题颜色

| 函数 | 用途 |
|------|------|
| `theme.fg("accent", text)` | 强调 |
| `theme.fg("success", text)` | 成功（绿） |
| `theme.fg("error", text)` | 错误（红） |
| `theme.fg("warning", text)` | 警告（黄） |
| `theme.fg("muted", text)` | 次级文本 |
| `theme.fg("dim", text)` | 三级文本 |
| `theme.fg("toolTitle", text)` | 工具名 |
| `theme.bold(text)` | 加粗 |

---

## 参考文档

- 主文档：`README.md`
- 扩展详解：`docs/extensions.md`
- TUI 组件：`docs/tui.md`
- 会话格式：`docs/session-format.md`
- 设置：`docs/settings.md`
- 键位：`docs/keybindings.md`
- 主题：`docs/themes.md`
- 示例目录：`examples/extensions/`

> 所有文档位于：`C:\Users\ManHua\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\`
