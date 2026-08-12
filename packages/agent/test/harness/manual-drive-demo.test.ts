import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ActionInfo } from "../../src/harness/agent-harness.ts";
import { type LaneReductionInput, type LaneState, reduceLaneState, validateRecordLog } from "../../src/harness/reducer.ts";
import type {
	CompactionEntry,
	Entry,
	EffectiveLaneConfiguration,
	LaneRecord,
	MessageEntry,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueEnqueuedRecord,
	RecordLogSlice,
	StepAttemptRecord,
	ToolStartedRecord,
	UsageRecord,
	WriteDeferredRecord,
} from "../../src/harness/session/types.ts";

/**
 * Demo: what a manual-drive step sees after each persisted record.
 *
 * AgentHarness.peekAction() is not yet implemented (v2 scaffold), but the
 * machinery a manual drive would sit on top of IS: reducer.reduceLaneState()
 * reconstructs the lane's full state from the persisted record log. This test
 * feeds records one at a time (the way manual drive would commit then peek)
 * and prints how the lane state advances.
 */

/**
 * Concept demo of the peekAction logic: derive the next ActionInfo from a
 * reconstructed LaneState. This mirrors the priority order harness.md §4.1
 * gives the real nextAction planning: abort -> queues -> deferred writes ->
 * missing inputs -> in-flight step result -> tool batch -> next generation.
 */
function deriveNextAction(state: LaneState): ActionInfo | undefined {
	const op = state.operation;
	if (!op) return undefined; // idle: acceptance is external

	if (op.aborting) return { kind: "finish_operation", outcome: "aborted" };

	if (op.pendingSteer.length > 0) {
		return { kind: "consume_queue_item", queue: "steer", entryId: op.pendingSteer[0]!.id };
	}
	if (op.pendingFollowUp.length > 0) {
		return { kind: "consume_queue_item", queue: "followUp", entryId: op.pendingFollowUp[0]!.id };
	}
	if (op.pendingWrites.length > 0) {
		return { kind: "apply_pending_write", entryId: op.pendingWrites[0]!.id };
	}
	if (op.missingInitialMessages.length > 0) {
		const target = op.missingInitialMessages[0]!;
		return { kind: "append_entry", entryType: target.type, entryId: target.id };
	}

	// A step in flight whose result entry has not landed yet: place the result.
	if (op.step) {
		const entryType: ActionInfo & { kind: "append_entry" } = (() => {
			switch (op.step!.kind) {
				case "assistant":
					return { kind: "append_entry", entryType: "message", entryId: op.step!.resultEntryId };
				case "compaction":
					return { kind: "append_entry", entryType: "compaction", entryId: op.step!.resultEntryId };
				case "branch_summary":
					return { kind: "append_entry", entryType: "branch_summary", entryId: op.step!.resultEntryId };
			}
		})();
		return entryType;
	}

	// Tool batch: execute the first unresolved call.
	if (op.toolBatch) {
		const call = op.toolBatch.calls.find((candidate) => !candidate.resultExists);
		if (call) return { kind: "execute_tool", toolCallId: call.toolCall.id, toolName: call.toolCall.name };
		if (op.toolBatch.truncated) return { kind: "try_finish_run", outcome: "failed" };
	}

	// No in-flight step, no tool work: start the next generation.
	if (op.kind === "run") return { kind: "stream_assistant", step: "assistant", attempt: 1 };

	return { kind: "finish_operation", outcome: "completed" };
}

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantWithToolCall(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function messageTarget(id: string, message: UserMessage | AssistantMessage | ToolResultMessage): ProvisionedEntry<MessageEntry> {
	return { type: "message", id, message };
}

function persistedEntry<TEntry extends Entry>(target: ProvisionedEntry<TEntry>, seq: number, parentId: string | null = null): TEntry {
	return { ...target, parentId, seq, timestamp: seq } as unknown as TEntry;
}

function runStarted(seq: number, id = "run-1"): OperationStartedRecord {
	return {
		type: "operation_started",
		id,
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

function attempt(
	seq: number,
	runId: string,
	step: StepAttemptRecord["step"],
	attemptNumber: number,
	resultEntryId: string,
	compactionReason?: "manual" | "threshold" | "overflow",
): StepAttemptRecord {
	const base = { type: "step_attempt", id: `attempt-${seq}`, lane: "main", seq, timestamp: seq, runId, step, attempt: attemptNumber, resultEntryId };
	return step === "compaction" ? { ...base, compactionReason: compactionReason ?? "manual" } : { ...base };
}

function toolStarted(seq: number, assistantEntryId: string, toolIndex: number, toolCallId: string, toolName: string, resultEntryId: string): ToolStartedRecord {
	return {
		type: "tool_started",
		id: `tool-start-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		runId: "run-1",
		assistantEntryId,
		toolIndex,
		toolCallId,
		toolName,
		effectiveArgs: {},
		resultEntryId,
		replay: "never",
	};
}

function queueEnqueued(seq: number, target: ProvisionedEntry, queue: QueueEnqueuedRecord["queue"] = "steer"): QueueEnqueuedRecord {
	const base = { type: "queue_enqueued" as const, id: `queue-${seq}`, lane: "main", seq, timestamp: seq, target };
	return queue === "nextRun" ? { ...base, queue } : { ...base, queue, runId: "run-1" };
}

function writeDeferred(seq: number, target: ProvisionedEntry): WriteDeferredRecord {
	return { type: "write_deferred", id: `write-${seq}`, lane: "main", seq, timestamp: seq, runId: "run-1", target };
}

function operationFinished(seq: number, runId = "run-1", outcome: OperationFinishedRecord["outcome"] = "completed"): OperationFinishedRecord {
	return { type: "operation_finished", id: `finish-${seq}`, lane: "main", seq, timestamp: seq, runId, outcome };
}

function usageRecord(seq: number, resultEntryId: string, stopReason: "length" | "error" = "length", attemptNumber = 1): UsageRecord {
	return {
		type: "usage",
		id: `usage-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		runId: "run-1",
		usage,
		attempt: attemptNumber,
		entryId: resultEntryId,
		stopReason,
	};
}

function compactionEntry(id: string, seq: number): CompactionEntry {
	return { type: "compaction", id, parentId: null, seq, timestamp: seq, summary: "summary", retainedTail: [], tokensBefore: 10 };
}

function recoverySlice(records: readonly LaneRecord[], entries: readonly Entry[] = []): RecordLogSlice {
	const finished = new Set(
		records.filter((record): record is OperationFinishedRecord => record.type === "operation_finished").map((record) => record.runId),
	);
	const openOperations = records
		.filter((record): record is OperationStartedRecord => record.type === "operation_started" && !finished.has(record.id))
		.sort((left, right) => right.seq - left.seq);
	return { lane: "main", openOperations, records, entries };
}

const defaults: EffectiveLaneConfiguration = {
	model: { provider: "default-provider", modelId: "default-model" },
	thinkingLevel: "off",
	activeToolNames: ["default-tool"],
};

function reductionInput(records: readonly LaneRecord[], ownEntries: readonly Entry[] = []): LaneReductionInput {
	const slice = recoverySlice(records, ownEntries);
	return {
		...slice,
		leafId: ownEntries.at(-1)?.id ?? null,
		ownEntries,
		configurationEntries: [],
		defaults,
	};
}

describe("manual-drive demo: lane state advances record by record", () => {
	it("shows the operation transitioning across a full run", () => {
		// --- Step 0: nothing persisted yet ---
		const steps: { label: string; records: LaneRecord[]; entries: Entry[] }[] = [];

		// A full run with one tool call, then a queued steer, then finish.
		const assistantEntry = persistedEntry(
			messageTarget("assistant-1", assistantWithToolCall([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "login.ts" } }])),
			2,
			"prompt-1",
		);
		const promptEntry = persistedEntry(messageTarget("prompt-1", userMessage("fix login")), 1);
		const toolResultEntry = persistedEntry(
			messageTarget("tool-result-1", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "login.ts: <the bug>" }],
				isError: false,
				timestamp: 1,
			} as ToolResultMessage),
			4,
			"assistant-1",
		);
		const steerTarget = messageTarget("steer-1", userMessage("explain first"));
		const deferredTarget = messageTarget("deferred-1", userMessage("deferred write"));

		// Record sequence as the drive would commit them:
		steps.push({
			label: "1. run accepted (operation_started)",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-1")],
			entries: [promptEntry, assistantEntry],
		});
		steps.push({
			label: "2. tool started (tool_started) - result still pending",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-1"), toolStarted(3, "assistant-1", 0, "call-1", "read", "tool-result-1")],
			entries: [promptEntry, assistantEntry],
		});
		steps.push({
			label: "3. tool result persisted - batch resolved",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "assistant-1"), toolStarted(3, "assistant-1", 0, "call-1", "read", "tool-result-1")],
			entries: [promptEntry, assistantEntry, toolResultEntry],
		});
		steps.push({
			label: "4. steer enqueued while run is open",
			records: [
				runStarted(1),
				attempt(2, "run-1", "assistant", 1, "assistant-1"),
				toolStarted(3, "assistant-1", 0, "call-1", "read", "tool-result-1"),
				queueEnqueued(5, steerTarget, "steer"),
			],
			entries: [promptEntry, assistantEntry, toolResultEntry],
		});
		steps.push({
			label: "5. write deferred (pending) then finished",
			records: [
				runStarted(1),
				attempt(2, "run-1", "assistant", 1, "assistant-1"),
				toolStarted(3, "assistant-1", 0, "call-1", "read", "tool-result-1"),
				queueEnqueued(5, steerTarget, "steer"),
				writeDeferred(6, deferredTarget),
				operationFinished(7),
			],
			entries: [promptEntry, assistantEntry, toolResultEntry],
		});

		const log: string[] = [];
		const actionLog: (ActionInfo | undefined)[] = [];
		for (const step of steps) {
			const input = reductionInput(step.records, step.entries);
			// Validation must pass for a legal prefix:
			expect(() => validateRecordLog(input)).not.toThrow();
			const result = reduceLaneState(input);
			const op = result.laneState.operation;
			const summary = op
				? `operation=${op.kind}(${op.id}) aborted=${op.aborting} step=${op.step ? `${op.step.kind}#${op.step.attempts}` : "none"} toolBatch=${op.toolBatch ? (op.toolBatch.unresolved ? "UNRESOLVED" : "resolved") : "none"} steerPending=${op.pendingSteer.length} followUpPending=${op.pendingFollowUp.length} writesPending=${op.pendingWrites.length} leaf=${result.laneState.leafId}`
				: `idle leaf=${result.laneState.leafId} nextRunPending=${result.laneState.pendingNextRun.length}`;
			const nextAction = deriveNextAction(result.laneState);
			log.push(`[${step.label}] -> ${summary}`);
			actionLog.push(nextAction);
			console.log(`[${step.label}] -> ${summary}`);
			console.log(`   peekAction -> ${nextAction ? JSON.stringify(nextAction) : "undefined (idle, waiting for external acceptance)"}`);
		}

		// A manual-drive caller would peek exactly these state fields each step.
		expect(log.length).toBe(5);
		// Step 1: assistant entry already persisted, so step reports none (settled),
		// but the tool batch from that assistant is still unresolved.
		expect(log[0]).toContain("operation=run(run-1)");
		expect(log[0]).toContain("toolBatch=UNRESOLVED");
		// Step 2: tool started, result not yet persisted -> batch still unresolved.
		expect(log[1]).toContain("toolBatch=UNRESOLVED");
		// Step 3: tool result entry landed -> batch resolves.
		expect(log[2]).toContain("toolBatch=resolved");
		// Step 4: steer enqueued -> pendingSteer visible.
		expect(log[3]).toContain("steerPending=1");
		// Step 5: operation finished -> lane idle, next-run queue empty.
		expect(log[4]).toContain("idle");

		// The derived peekAction sequence is the manual drive's step-by-step plan:
		// run accepted -> tool start pending -> execute tool -> (after tool resolves)
		// next generation would start, but steer preempts -> finish.
		expect(actionLog).toHaveLength(5);
		expect(actionLog[0]).toEqual({ kind: "execute_tool", toolCallId: "call-1", toolName: "read" });
		expect(actionLog[1]).toEqual({ kind: "execute_tool", toolCallId: "call-1", toolName: "read" });
		expect(actionLog[2]).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		expect(actionLog[3]).toEqual({ kind: "consume_queue_item", queue: "steer", entryId: "steer-1" });
		expect(actionLog[4]).toBeUndefined(); // idle
	});

	it("reconstructs the overflow recovery path (length stop -> compaction -> retry)", () => {
		// Real overflow sequence from reducer.test.ts "overflow compaction and retry":
		// assistant reply hit the token limit -> usage records "length" -> a
		// compaction step is issued with reason "overflow" -> after its result
		// lands, the assistant retries and this time fits.
		const steps: { label: string; records: LaneRecord[]; entries: Entry[] }[] = [];

		const overflowAssistant = persistedEntry(
			messageTarget("discarded-overflow", assistantWithToolCall([{ type: "text", text: "long truncated reply" }])),
			2,
		);
		const overflowSummary = compactionEntry("overflow-compaction", 5);
		const retriedAssistant = persistedEntry(messageTarget("assistant-after-compaction", assistantWithToolCall([{ type: "text", text: "fits" }])), 7);

		steps.push({
			label: "1. assistant reply hit token limit",
			records: [runStarted(1), attempt(2, "run-1", "assistant", 1, "discarded-overflow"), usageRecord(3, "discarded-overflow", "length")],
			entries: [overflowAssistant],
		});
		steps.push({
			label: "2. overflow compaction issued (reason=overflow)",
			records: [
				runStarted(1),
				attempt(2, "run-1", "assistant", 1, "discarded-overflow"),
				usageRecord(3, "discarded-overflow", "length"),
				attempt(4, "run-1", "compaction", 1, "overflow-compaction", "overflow"),
			],
			entries: [overflowAssistant],
		});
		steps.push({
			label: "3. compaction result persisted",
			records: [
				runStarted(1),
				attempt(2, "run-1", "assistant", 1, "discarded-overflow"),
				usageRecord(3, "discarded-overflow", "length"),
				attempt(4, "run-1", "compaction", 1, "overflow-compaction", "overflow"),
			],
			entries: [overflowAssistant, overflowSummary],
		});
		steps.push({
			label: "4. assistant retried and completed",
			records: [
				runStarted(1),
				attempt(2, "run-1", "assistant", 1, "discarded-overflow"),
				usageRecord(3, "discarded-overflow", "length"),
				attempt(4, "run-1", "compaction", 1, "overflow-compaction", "overflow"),
				attempt(6, "run-1", "assistant", 1, "assistant-after-compaction"),
			],
			entries: [overflowAssistant, overflowSummary, retriedAssistant],
		});

		const log: string[] = [];
		const actionLog: (ActionInfo | undefined)[] = [];
		let overflowRecoveryUsed: boolean | undefined;
		for (const step of steps) {
			const input = reductionInput(step.records, step.entries);
			expect(() => validateRecordLog(input)).not.toThrow();
			const result = reduceLaneState(input);
			const op = result.laneState.operation;
			overflowRecoveryUsed = op?.overflowRecoveryUsed;
			const summary = op
				? `operation=${op.kind}(${op.id}) step=${op.step ? `${op.step.kind}#${op.step.attempts}` : "none"} overflowRecovery=${op.overflowRecoveryUsed}`
				: "idle";
			const nextAction = deriveNextAction(result.laneState);
			log.push(`[${step.label}] -> ${summary}`);
			actionLog.push(nextAction);
			console.log(`[${step.label}] -> ${summary}`);
			console.log(`   peekAction -> ${nextAction ? JSON.stringify(nextAction) : "undefined (idle)"}`);
		}

		// The overflow flag flips on once the overflow compaction attempt is seen
		// (reducer.ts:587-593), and stays set through the retried assistant step.
		expect(log).toHaveLength(4);
		expect(overflowRecoveryUsed).toBe(true);

		// Derived actions, matched against the reducer's real semantics:
		// 1. assistant reply was already persisted (attempt settled -> step=null),
		//    so the next action is to retry the assistant generation.
		// 2. the overflow compaction attempt is in flight (step=compaction#1,
		//    overflowRecovery=true) -> place its result entry.
		// 3. compaction result landed (step=null) -> retry the assistant.
		// 4. retried assistant completed -> next generation continues.
		expect(actionLog).toHaveLength(4);
		expect(actionLog[0]).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		expect(actionLog[1]).toEqual({ kind: "append_entry", entryType: "compaction", entryId: "overflow-compaction" });
		expect(actionLog[2]).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
		expect(actionLog[3]).toEqual({ kind: "stream_assistant", step: "assistant", attempt: 1 });
	});
});
