/**
 * Native Durable loop/monitor extension (settings-only).
 *
 * Desktop behavior in `src/index.ts` is unchanged. This module adds a separate
 * `/durable` factory for a Durable 1.1 host. Settings are plain numbers, copied
 * and frozen at creation. There are no scheduler, process, auth, storage, or
 * host callbacks. Real Node/Durable capabilities perform the work internally:
 * existing `loop-parse` utilities validate cron/interval input, `TaskRuntime`
 * conversation handles admit durable wakes, `runtime.sleep` enforces wake times,
 * document watches observe pause/delete/stop, and `ExecutionEnv.exec` runs
 * monitor commands where the host provides a Node environment.
 *
 * State is one conversation-scoped document `pi-loop.state`
 * (`history: "latest"`, `fork: "initial"`): forks start empty so a fork cannot
 * duplicate live controllers. Loop and monitor tasks are conversation-owned
 * `background: true` boundaries; ordinary conversation aborts and idle waits do
 * not cross them. Only their own durable record (pause/delete/stop) or Harness
 * close stops them. Tool waits are cancellation-aware; cancellation never
 * undoes admitted work.
 *
 * Recovery is ownership loss, never respawn: a monitor task that re-enters its
 * running checkpoint after reopen marks the monitor `unknown` without spawning
 * a new process and never labels it running; loop wake admissions are
 * deduplicated by deterministic request id, so a rerun after interruption does
 * not duplicate a wake.
 *
 * Concrete native exclusions (not placeholders):
 * - Event and hybrid triggers need the desktop Pi event bus; they are rejected
 *   at creation with the supported cron/interval/idle alternatives. There is no
 *   `readOnly` parameter: read-only wakes depend on the desktop pi-ask guard
 *   protocol and Herdr events, which have no native equivalent.
 * - `MonitorCreate` has no `hcTerminalId`/`onSignal` parameters; Core terminal
 *   subscriptions are desktop-only and are rejected. `onDone` is a durable
 *   conversation input, not a desktop notification or event.
 * - No `/loop` or `/monitors` commands, widget/overlay/dashboard, full
 *   stdout/stderr capture files, output event rate limiting, notifications, or
 *   cross-process monitor continuation. Monitors keep a bounded durable tail
 *   (configured `maxOutputLines`/`maxOutputLineChars`, committed every
 *   `outputCommitMs`) and explicit status only.
 * - A recovered monitor is `unknown`, never `running`. Paused or deleted loops
 *   are terminal; recreate them explicitly to run again.
 */
import { randomUUID } from "node:crypto";
import type { Extension, TaskId } from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { cronToNextFire, isValidCronExpression, parseInterval } from "./loop-parse.js";

export const LOOP_MONITOR_DURABLE_EXTENSION_NAME = "pi-loop-monitor";

export type LoopMonitorDurableSettings = {
  readonly defaultMonitorTimeoutMs?: number;
  readonly maxMonitorTimeoutMs?: number;
  readonly maxMonitors?: number;
  readonly maxLoops?: number;
  readonly loopLifetimeMs?: number;
  readonly outputCommitMs?: number;
  readonly maxOutputLines?: number;
  readonly maxOutputLineChars?: number;
};

type ResolvedSettings = {
  defaultMonitorTimeoutMs: number;
  maxMonitorTimeoutMs: number;
  maxMonitors: number;
  maxLoops: number;
  loopLifetimeMs: number;
  outputCommitMs: number;
  maxOutputLines: number;
  maxOutputLineChars: number;
};

const DEFAULTS: ResolvedSettings = {
  defaultMonitorTimeoutMs: 300_000,
  maxMonitorTimeoutMs: 86_400_000,
  maxMonitors: 25,
  maxLoops: 25,
  loopLifetimeMs: 7 * 24 * 60 * 60 * 1000,
  outputCommitMs: 500,
  maxOutputLines: 40,
  maxOutputLineChars: 500,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampInt(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`loop-monitor durable settings: ${name} must be an integer ${min}..${max}.`);
  }
  return value;
}

function resolveSettings(input: LoopMonitorDurableSettings = {}): ResolvedSettings {
  const out = { ...DEFAULTS };
  if (input.defaultMonitorTimeoutMs !== undefined) {
    if (!isFiniteNumber(input.defaultMonitorTimeoutMs) || input.defaultMonitorTimeoutMs < 0) {
      throw new Error("loop-monitor durable settings: defaultMonitorTimeoutMs must be a finite number >= 0.");
    }
    out.defaultMonitorTimeoutMs = Math.min(input.defaultMonitorTimeoutMs, out.maxMonitorTimeoutMs);
  }
  if (input.maxMonitorTimeoutMs !== undefined) {
    if (!isFiniteNumber(input.maxMonitorTimeoutMs) || input.maxMonitorTimeoutMs <= 0) {
      throw new Error("loop-monitor durable settings: maxMonitorTimeoutMs must be a finite number > 0.");
    }
    out.maxMonitorTimeoutMs = input.maxMonitorTimeoutMs;
    out.defaultMonitorTimeoutMs = Math.min(out.defaultMonitorTimeoutMs, out.maxMonitorTimeoutMs);
  }
  if (input.maxMonitors !== undefined) out.maxMonitors = clampInt(input.maxMonitors, 1, 100, "maxMonitors");
  if (input.maxLoops !== undefined) out.maxLoops = clampInt(input.maxLoops, 1, 100, "maxLoops");
  if (input.loopLifetimeMs !== undefined) {
    if (!isFiniteNumber(input.loopLifetimeMs) || input.loopLifetimeMs <= 0) {
      throw new Error("loop-monitor durable settings: loopLifetimeMs must be a finite number > 0.");
    }
    out.loopLifetimeMs = Math.min(input.loopLifetimeMs, 30 * 24 * 60 * 60 * 1000);
  }
  if (input.outputCommitMs !== undefined) {
    if (!isFiniteNumber(input.outputCommitMs) || input.outputCommitMs < 50) {
      throw new Error("loop-monitor durable settings: outputCommitMs must be a finite number >= 50.");
    }
    out.outputCommitMs = Math.min(input.outputCommitMs, 10_000);
  }
  if (input.maxOutputLines !== undefined) out.maxOutputLines = clampInt(input.maxOutputLines, 1, 200, "maxOutputLines");
  if (input.maxOutputLineChars !== undefined) {
    out.maxOutputLineChars = clampInt(input.maxOutputLineChars, 50, 5000, "maxOutputLineChars");
  }
  return Object.freeze(out);
}

type LoopTriggerState = { type: "cron"; schedule: string } | { type: "dynamic" };

type LoopRecordState = {
  prompt: string;
  trigger: LoopTriggerState;
  status: "active" | "paused" | "completed" | "error";
  recurring: boolean;
  fireCount: number;
  maxFires?: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  nextWakeAt?: number;
  awaitingUpdate?: boolean;
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  iteration?: number;
  lastError?: string;
};

type MonitorProgressState = {
  current?: number;
  total?: number;
  message?: string;
};

type MonitorRecordState = {
  command: string;
  description?: string;
  status: "starting" | "running" | "completed" | "error" | "stopped" | "unknown";
  exitCode?: number;
  stopReason?: string;
  outputLines: number;
  outputTail: string[];
  progress?: MonitorProgressState;
  stopRequested: boolean;
  timeoutMs: number;
  onDone?: string;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};

type LoopMonitorDocState = {
  loops: Record<string, LoopRecordState>;
  monitors: Record<string, MonitorRecordState>;
};

const LoopMonitorDoc = defineDoc({
  kind: "pi-loop.state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): LoopMonitorDocState => ({ loops: {}, monitors: {} }),
});

function boundText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function parseDelayMs(input: string): number | undefined {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const delay = value * multiplier;
  if (!Number.isSafeInteger(delay) || delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return undefined;
  return delay;
}

type ToolApi = Parameters<Parameters<typeof defineTool>[0]["execute"]>[1];
type ToolContext = Parameters<Parameters<typeof defineTool>[0]["execute"]>[2];

async function readDoc(api: ToolApi, context: ToolContext): Promise<LoopMonitorDocState | undefined> {
  return api.snapshot(LoopMonitorDoc, api.conversationId, context);
}

function formatProgress(progress: MonitorProgressState): string {
  const ratio =
    progress.current !== undefined && progress.total !== undefined && progress.total > 0
      ? `${Math.round((progress.current / progress.total) * 100)}% (${progress.current}/${progress.total})`
      : progress.current !== undefined
        ? String(progress.current)
        : "";
  return [ratio, progress.message].filter(Boolean).join(" · ") || "updated";
}

// --- Background loop task ---

type LoopTaskInput = {
  prompt: string;
  trigger: LoopTriggerState;
  recurring: boolean;
  maxFires?: number;
  expiresAt: number;
};

type LoopWaitCheckpoint = {
  phase: "wait";
  wakeAt?: number;
  fireCount: number;
};

type LoopDeliverCheckpoint = {
  phase: "deliver";
  fireCount: number;
  /** Stable pending fire identity: submission request id admitted before any count or phase advance. */
  requestId: string;
  /** Prompt captured from the current target record for this pending wake. */
  prompt: string;
  wakeAt?: number;
};

type LoopTaskCheckpoint = LoopWaitCheckpoint | LoopDeliverCheckpoint;

type LoopTaskResult = {
  loopKey: string;
  status: string;
};
function nextCronWake(schedule: string, now: number): number {
  return cronToNextFire(schedule, new Date(now + 1000)).getTime();
}

const LoopTask = defineTask<LoopTaskInput, LoopTaskCheckpoint, LoopTaskResult, object>({
  name: "pi-loop.loop",
  version: 1,
  initial: (input: LoopTaskInput): LoopTaskCheckpoint => ({ phase: "wait", fireCount: 0 }),
  phases: {
    wait: async (task, runtime, context) => {
      const input = task.input as LoopTaskInput;
      // The record key is the task's own id: the tool writes it atomically
      // with task creation, so the scheduler can never observe a live task
      // without its record.
      const loopKey = String(runtime.taskId);
      // Re-evaluate inside this handler until a genuinely changed deliver
      // checkpoint or terminal state commits: the scheduler faults a wait
      // handler that returns its entry checkpoint unchanged, so watch wakes
      // and relevant changes loop back here instead of committing wait.
      reevaluate: for (;;) {
      const state = await runtime.snapshot(LoopMonitorDoc, runtime.conversationId, context);
      const record = state?.loops[loopKey];
      const now = runtime.now();
      if (!record || record.status !== "active") {
        await runtime.commit(() => ({
          status: "terminal",
          outcome: { status: "completed", result: { loopKey, status: record?.status ?? "deleted" } },
        }), context);
        return;
      }
      if (now >= record.expiresAt || now >= input.expiresAt) {
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const current = (draft.loops as Record<string, LoopRecordState>)[loopKey];
          if (current && current.status === "active") {
            current.status = "completed";
            current.updatedAt = runtime.now();
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: { loopKey, status: "completed" } },
          };
        }, context);
        return;
      }
      if (record.trigger.type === "dynamic" && record.awaitingUpdate && (record.fireCount ?? 0) > 0) {
        const watch = await runtime.watchDoc(LoopMonitorDoc, runtime.conversationId, context);
        if (!watch) {
          // No observable document: poll by re-evaluating after a bounded
          // cadence rather than returning an unchanged checkpoint.
          try {
            await runtime.sleep(runtime.now() + 5000, context);
          } catch {
            await runtime.commit(() => ({
              status: "terminal",
              outcome: { status: "aborted", reason: "loop wait aborted" },
            }), context);
            return;
          }
          continue;
        }
        let changed = false;
        const changedPromise = new Promise<void>((resolve) => {
          watch.start(async () => {
            changed = true;
            resolve();
          });
        });
        const abortPromise = new Promise<void>((resolve) => {
          const signal = runtime.signal;
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([changedPromise, abortPromise]);
        await watch.stop().catch(() => undefined);
        if (!changed) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "aborted", reason: "loop wait aborted" },
          }), context);
          return;
        }
        continue;
      }
      // Select the due time and capture the pending fire identity up front.
      // The deliver checkpoint carries the request id and prompt, so a
      // recovery re-entry resubmits the same wake instead of losing it.
      const fireNumber = (record.fireCount ?? 0) + 1;
      const requestId = `loop:${String(runtime.taskId)}:${fireNumber}`;
      const prompt = record.prompt;
      const relevantOf = (entry: LoopRecordState | undefined): string =>
        JSON.stringify(entry === undefined ? null : {
          status: entry.status,
          trigger: entry.trigger,
          nextWakeAt: entry.nextWakeAt,
          expiresAt: entry.expiresAt,
          prompt: entry.prompt,
        });
      const baseline = relevantOf(record);
      let wakeAt: number;
      if (record.trigger.type === "dynamic") {
        if ((record.fireCount ?? 0) === 0) {
          wakeAt = now;
        } else if (record.nextWakeAt !== undefined) {
          wakeAt = record.nextWakeAt;
        } else {
          wakeAt = now;
        }
      } else {
        try {
          wakeAt = nextCronWake(record.trigger.schedule, now);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
            const current = (draft.loops as Record<string, LoopRecordState>)[loopKey];
            if (current) {
              current.status = "error";
              current.lastError = detail.slice(0, 500);
              current.updatedAt = runtime.now();
            }
            return {
              status: "terminal",
              outcome: { status: "failed", error: { message: `Invalid cron schedule: ${detail}` } },
            };
          }, context);
          return;
        }
      }
      if (wakeAt > now) {
        // Retain the selected due time across unrelated shared-document
        // writes (e.g. monitor output commits). Only the target loop's own
        // control or schedule changes reschedule the wait.
        let dueAt = wakeAt;
        for (;;) {
          const watch = await runtime.watchDoc(LoopMonitorDoc, runtime.conversationId, context);
          if (!watch) {
            // No observable document: sleep out the selected due time, then
            // deliver; deliver re-checks the record before submitting.
            try {
              await runtime.sleep(dueAt, context);
            } catch {
              await runtime.commit(() => ({
                status: "terminal",
                outcome: { status: "aborted", reason: "loop wait aborted" },
              }), context);
              return;
            }
            break;
          }
          let controlChanged = false;
          const gate = new Promise<void>((resolve) => {
            watch.start(async () => {
              controlChanged = true;
              resolve();
            });
          });
          const stopWatch = (): Promise<unknown> => watch.stop().catch(() => undefined);
          const sleep = runtime.sleep(dueAt, context).then(() => "slept" as const).catch(() => "aborted" as const);
          const raced = await Promise.race([sleep, gate.then(() => "changed" as const)]);
          await stopWatch();
          if (raced === "aborted") {
            await runtime.commit(() => ({
              status: "terminal",
              outcome: { status: "aborted", reason: "loop wait aborted" },
            }), context);
            return;
          }
          if (controlChanged) {
            const fresh = await runtime.snapshot(LoopMonitorDoc, runtime.conversationId, context).catch(() => undefined);
            if (relevantOf(fresh?.loops[loopKey]) === baseline) {
              // Unrelated write: keep the selected due time when it is still
              // in the future, or deliver it now that it has been reached.
              // Only the target loop's own relevant change reschedules.
              if (dueAt > runtime.now()) continue;
              break;
            }
            continue reevaluate;
          }
          break;
        }
      }
      await runtime.commit(() => ({
        status: "running",
        checkpoint: { phase: "deliver", wakeAt, fireCount: fireNumber, requestId, prompt } satisfies LoopTaskCheckpoint,
      }), context);
      return;
      }
    },
    deliver: async (task, runtime, context) => {
      const input = task.input as LoopTaskInput;
      const loopKey = String(runtime.taskId);
      // Stable pending fire carried by the checkpoint: commit() returns void,
      // so the checkpoint (not a commit result) identifies this admission.
      // A recovery re-entry resubmits the same request id, which Durable
      // deduplicates, instead of losing the wake.
      const pending = task.state.checkpoint;
      const now = runtime.now();
      const pre = await runtime.snapshot(LoopMonitorDoc, runtime.conversationId, context);
      const target = pre?.loops[loopKey];
      if (!target || target.status !== "active") {
        await runtime.commit(() => ({
          status: "terminal",
          outcome: { status: "completed", result: { loopKey, status: target?.status ?? "deleted" } },
        }), context);
        return;
      }
      if (now >= target.expiresAt) {
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const current = (draft.loops as Record<string, LoopRecordState>)[loopKey];
          if (current && current.status === "active") {
            current.status = "completed";
            current.updatedAt = runtime.now();
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: { loopKey, status: "completed" } },
          };
        }, context);
        return;
      }
      // Admit the pending wake before advancing any count or phase. Only a
      // confirmed admission below may advance the record and checkpoint.
      try {
        const handle = await runtime.conversation(runtime.conversationId, context);
        if (!handle) throw new Error("own conversation is unavailable");
        await handle.submit(
          { type: "input", content: pending.prompt, requestId: pending.requestId, whenBusy: "followUp" },
          context,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const current = (draft.loops as Record<string, LoopRecordState>)[loopKey];
          if (current) {
            current.status = "error";
            current.lastError = detail.slice(0, 500);
            current.updatedAt = runtime.now();
          }
          return {
            status: "terminal",
            outcome: { status: "failed", error: { message: `Loop wake was not admitted: ${detail}` } },
          };
        }, context);
        return;
      }
      // Confirmed admission: advance the count idempotently (assign, not
      // increment, so a recovery re-entry cannot double-count), then either
      // retire the loop or return to wait.
      const admittedAt = runtime.now();
      await runtime.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
        const loops = draft.loops as Record<string, LoopRecordState>;
        const current = loops[loopKey];
        const done = !input.recurring
          || (current?.maxFires !== undefined && pending.fireCount >= current.maxFires)
          || admittedAt >= (current?.expiresAt ?? admittedAt);
        if (current && current.status === "active") {
          current.fireCount = pending.fireCount;
          current.updatedAt = admittedAt;
          if (current.trigger.type === "dynamic") {
            current.awaitingUpdate = true;
            delete current.nextWakeAt;
          }
          if (done) {
            current.status = "completed";
          }
        }
        if (!current || current.status !== "active") {
          return {
            status: "terminal",
            outcome: { status: "completed", result: { loopKey, status: current?.status ?? "deleted" } },
          };
        }
        return {
          status: "running",
          checkpoint: { phase: "wait", fireCount: pending.fireCount } satisfies LoopTaskCheckpoint,
        };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    const loopKey = String(runtime.taskId);
    await runtime.commit(async (tx) => {
      const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
      const loops = draft.loops as Record<string, LoopRecordState>;
      const current = loops[loopKey];
      if (current && current.status === "active") {
        current.status = "paused";
        current.updatedAt = runtime.now();
      }
      return {
        status: "terminal",
        outcome: { status: "aborted", reason: "loop aborted" },
      };
    }, context).catch(() => undefined);
  },
});

// --- Background monitor task ---

type MonitorTaskInput = {
  command: string;
  description?: string;
  timeoutMs: number;
  onDone?: string;
  maxOutputLines: number;
  maxOutputLineChars: number;
  outputCommitMs: number;
};

type MonitorStartCheckpoint = {
  phase: "start";
};

type MonitorRunCheckpoint = {
  phase: "run";
  launchNonce?: string;
  startedAt?: number;
};

type MonitorTaskCheckpoint = MonitorStartCheckpoint | MonitorRunCheckpoint;

type MonitorTaskResult = {
  monitorKey: string;
  status: string;
};

function childContext(parent: ToolContext, signal: AbortSignal): ToolContext {
  const parentSignal = parent.abortSignal;
  const combined = parentSignal ? AbortSignal.any([parentSignal, signal]) : signal;
  return {
    get abortSignal() {
      return combined;
    },
    get telemetry() {
      return parent.telemetry;
    },
    value: (key) => parent.value(key),
    toString: () => `${parent.toString()}.withAbort`,
  } as ToolContext;
}

const MonitorTask = defineTask<MonitorTaskInput, MonitorTaskCheckpoint, MonitorTaskResult, object>({
  name: "pi-loop.monitor",
  version: 1,
  initial: (_input: MonitorTaskInput): MonitorTaskCheckpoint => ({ phase: "start" }),
  phases: {
    start: async (task, runtime, context) => {
      const nonce = randomUUID();
      await runtime.commit(() => ({
        status: "running",
        checkpoint: { phase: "run", launchNonce: nonce, startedAt: runtime.now() } satisfies MonitorTaskCheckpoint,
      }), context);
    },
    run: async (task, runtime, context) => {
      const input = task.input as MonitorTaskInput;
      // The record key is the task's own id: the tool writes it atomically
      // with task creation, so the scheduler can never observe a live task
      // without its record.
      const monitorKey = String(runtime.taskId);
      const checkpoint = task.state.checkpoint;
      // Fail closed: memo read/write failures must fault this invocation
      // before env.exec, never read as "no prior launch". Only a confirmed
      // durable winner equal to this invocation's nonce may dispatch.
      const alreadyLaunched = await runtime.memo<string>("launched", context);
      if (alreadyLaunched !== undefined || !checkpoint.launchNonce) {
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const monitors = draft.monitors as Record<string, MonitorRecordState>;
          const current = monitors[monitorKey];
          if (current && (current.status === "starting" || current.status === "running")) {
            current.status = "unknown";
            current.lastError = "Process ownership was lost on recovery; the command was not respawned.";
            current.updatedAt = runtime.now();
          }
          return {
            status: "terminal",
            outcome: { status: "failed", error: { message: "Monitor ownership was lost on recovery." } },
          };
        }, context).catch(() => undefined);
        return;
      }
      const winner = await runtime.memo("launched", checkpoint.launchNonce, context);
      if (winner !== checkpoint.launchNonce) {
        throw new Error("Monitor launch memo winner mismatch; refusing dispatch.");
      }
      const env = await runtime.env(context).catch(() => undefined);
      if (!env) {
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const monitors = draft.monitors as Record<string, MonitorRecordState>;
          const current = monitors[monitorKey];
          if (current) {
            current.status = "error";
            current.lastError = "No execution environment is available in this host.";
            current.updatedAt = runtime.now();
          }
          return {
            status: "terminal",
            outcome: { status: "failed", error: { message: "No execution environment is available." } },
          };
        }, context).catch(() => undefined);
        return;
      }
      // A stop committed before dispatch must prevent starting the command:
      // check the current record before env.exec. A stop racing after a
      // confirmed dispatch is still handled by post-dispatch cancellation.
      const preDispatch = await runtime.snapshot(LoopMonitorDoc, runtime.conversationId, context).catch(() => undefined);
      const preRecord = preDispatch?.monitors[monitorKey];
      if (!preRecord || preRecord.stopRequested || (preRecord.status !== "starting" && preRecord.status !== "running")) {
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const monitors = draft.monitors as Record<string, MonitorRecordState>;
          const current = monitors[monitorKey];
          if (!current) {
            return {
              status: "terminal",
              outcome: { status: "completed", result: { monitorKey, status: "deleted" } },
            };
          }
          if (current.status === "starting" || current.status === "running") {
            current.status = "stopped";
            current.stopReason = "manual";
            current.updatedAt = runtime.now();
          }
          return {
            status: "terminal",
            outcome: current.status === "stopped"
              ? { status: "aborted", reason: "monitor stopped before dispatch" }
              : { status: "completed", result: { monitorKey, status: current.status } },
          };
        }, context).catch(() => undefined);
        return;
      }
      await runtime.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
        const monitors = draft.monitors as Record<string, MonitorRecordState>;
        const current = monitors[monitorKey];
        if (current && current.status === "starting") {
          current.status = "running";
          current.lastActivityAt = runtime.now();
          current.updatedAt = runtime.now();
        }
        return undefined;
      }, context).catch(() => undefined);

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      runtime.signal.addEventListener("abort", onAbort, { once: true });
      const execContext = childContext(context, controller.signal);
      const maxLines = input.maxOutputLines;
      const maxChars = input.maxOutputLineChars;
      const commitIntervalMs = input.outputCommitMs;
      let tail: string[] = [];
      let remainder = "";
      let outputLines = 0;
      let lastActivity = runtime.now();
      let lastCommit = 0;
      const cleanLine = (line: string): string =>
        line.length > maxChars ? `${line.slice(0, maxChars)}… [truncated]` : line;
      const appendLine = (raw: string): void => {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line) return;
        tail = [...tail, cleanLine(line)].slice(-maxLines);
        outputLines += 1;
      };
      const flushRemainder = (): void => {
        if (!remainder) return;
        appendLine(remainder);
        remainder = "";
      };
      const commitTail = async (): Promise<void> => {
        const snapshotTail = [...tail];
        const snapshotLines = outputLines;
        const snapshotActivity = lastActivity;
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
          const monitors = draft.monitors as Record<string, MonitorRecordState>;
          const current = monitors[monitorKey];
          if (current && (current.status === "running" || current.status === "starting")) {
            current.outputTail = snapshotTail;
            current.outputLines = snapshotLines;
            current.lastActivityAt = Math.max(current.lastActivityAt, snapshotActivity);
            current.updatedAt = runtime.now();
          }
          return undefined;
        }, context).catch(() => undefined);
        lastCommit = runtime.now();
      };
      const execPromise = env.exec(input.command, {
        onOutput: (text) => {
          lastActivity = runtime.now();
          const combined = `${remainder}${text}`;
          const parts = combined.split("\n");
          // Bound the incomplete no-newline tail the same way as full lines.
          remainder = (parts.pop() ?? "").slice(0, maxChars + 1);
          for (const raw of parts) appendLine(raw);
          if (runtime.now() - lastCommit >= commitIntervalMs) void commitTail();
        },
      }, execContext).then((result) => ({ kind: "settled" as const, result })).catch((error: unknown) => ({ kind: "error" as const, error }));

      let terminal: { status: "completed" | "error" | "stopped" | "unknown"; exitCode?: number; reason?: string } | undefined;
      while (!terminal) {
        const snap = await runtime.snapshot(LoopMonitorDoc, runtime.conversationId, context).catch(() => undefined);
        const rec = snap?.monitors[monitorKey];
        if (!rec || rec.stopRequested) {
          controller.abort();
          const settled = await execPromise;
          flushRemainder();
          await commitTail();
          terminal = { status: "stopped", reason: "manual" };
          void settled;
          break;
        }
        if (input.timeoutMs > 0 && runtime.now() - Math.max(lastActivity, rec.lastActivityAt) > input.timeoutMs) {
          controller.abort();
          await execPromise;
          flushRemainder();
          await commitTail();
          terminal = { status: "stopped", reason: "timeout" };
          break;
        }
        const winner = await Promise.race([
          execPromise.then((value) => ({ kind: "exec" as const, value })),
          // Disabled timeout sleeps only the check cadence; an enabled one
          // uses the effective inactivity deadline, renewed by output and by
          // structured progress committed through MonitorUpdate.
          runtime.sleep(
            input.timeoutMs > 0
              ? Math.min(Math.max(lastActivity, rec.lastActivityAt) + input.timeoutMs, runtime.now() + 5000)
              : runtime.now() + 5000,
            context,
          ).then(() => ({ kind: "tick" as const })).catch(() => ({ kind: "aborted" as const })),
        ]);
        if (winner.kind === "exec") {
          flushRemainder();
          await commitTail();
          const settled = winner.value;
          if (settled.kind === "error") {
            terminal = { status: "error", reason: settled.error instanceof Error ? settled.error.message : String(settled.error) };
          } else if (!settled.result.ok) {
            const code = settled.result.error.code;
            terminal = code === "aborted"
              ? { status: "stopped", reason: "manual" }
              : code === "timeout"
                ? { status: "stopped", reason: "timeout" }
                : { status: "error", reason: settled.result.error.message };
          } else {
            const exitCode = settled.result.value.exitCode;
            terminal = exitCode === 0 ? { status: "completed", exitCode } : { status: "error", exitCode };
          }
          break;
        }
        if (winner.kind === "aborted") {
          controller.abort();
          await execPromise;
          await commitTail();
          terminal = { status: "stopped", reason: "manual" };
          break;
        }
      }
      runtime.signal.removeEventListener("abort", onAbort);
      const final = terminal ?? { status: "unknown" as const };
      const finishedTail = [...tail];
      const finishedLines = outputLines;
      // Admit the onDone wake while this invocation is still live: invocation
      // APIs reject after the terminal commit below, so submitting afterwards
      // would lose the wake. The deterministic request id deduplicates it.
      if ((final.status === "completed" || final.status === "error" || final.status === "stopped") && input.onDone) {
        try {
          const handle = await runtime.conversation(runtime.conversationId, context);
          if (handle) {
            await handle.submit(
              {
                type: "input",
                content: `${input.onDone}\nMonitor ${monitorKey} finished with status ${final.status}${final.exitCode !== undefined ? ` (exit ${final.exitCode})` : ""}.`,
                requestId: `monitor:${String(task.id)}:done`,
                whenBusy: "followUp",
              },
              context,
            );
          }
        } catch {
          runtime.report(new Error(`Monitor ${monitorKey} onDone wake was not admitted.`));
        }
      }
      await runtime.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
        const monitors = draft.monitors as Record<string, MonitorRecordState>;
        const current = monitors[monitorKey];
        if (current) {
          current.status = final.status;
          current.outputTail = finishedTail;
          current.outputLines = finishedLines;
          if (final.exitCode !== undefined) current.exitCode = final.exitCode;
          if (final.reason !== undefined) current.stopReason = final.reason;
          if (final.status === "unknown" || final.status === "error") {
            current.lastError = final.reason ?? "Monitor ended without a terminal receipt.";
          }
          current.updatedAt = runtime.now();
        }
        return {
          status: "terminal",
          outcome: final.status === "completed"
            ? { status: "completed", result: { monitorKey, status: final.status } }
            : final.status === "stopped"
              ? { status: "aborted", reason: final.reason ?? "stopped" }
              : { status: "failed", error: { message: final.reason ?? "Monitor failed." } },
        };
      }, context).catch(() => undefined);
    },
  },
  abort: async (task, runtime, context) => {
    const monitorKey = String(runtime.taskId);
    await runtime.commit(async (tx) => {
      const draft = await tx.doc(LoopMonitorDoc, runtime.conversationId);
      const monitors = draft.monitors as Record<string, MonitorRecordState>;
      const current = monitors[monitorKey];
      if (current && (current.status === "starting" || current.status === "running")) {
        current.status = "stopped";
        current.stopReason = "manual";
        current.updatedAt = runtime.now();
      }
      return {
        status: "terminal",
        outcome: { status: "aborted", reason: "monitor aborted" },
      };
    }, context).catch(() => undefined);
  },
});

// --- Tool parameter schemas ---

const loopCreateParameters = Type.Object({
  trigger: Type.String({ minLength: 1, maxLength: 256, description: "Cron expression (e.g. '5m', '1h', '0 9 * * 1-5') or literal 'idle' for agent-paced continuation." }),
  prompt: Type.String({ minLength: 1, maxLength: 8000, description: "Prompt to run when the loop fires." }),
  recurring: Type.Optional(Type.Boolean({ description: "Whether the loop repeats (default true)." })),
  triggerType: Type.Optional(Type.String({ enum: ["cron", "idle"] })),
  maxFires: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
});

const loopUpdateParameters = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.String({ enum: ["continue", "completed", "paused"] }),
  state: Type.Optional(Type.String({ maxLength: 4000 })),
  metrics: Type.Optional(Type.String({ maxLength: 4000 })),
  doneCriteria: Type.Optional(Type.String({ maxLength: 4000 })),
  nextInterval: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
});

const loopDeleteParameters = Type.Object({
  id: Type.String({ minLength: 1 }),
  action: Type.Optional(Type.String({ enum: ["delete", "pause"], default: "delete" })),
});

const monitorCreateParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 8000, description: "Shell command to run in the background." }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, description: "Inactivity timeout in ms (default 300000, 0 disables)." })),
  onDone: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});

const monitorIdParameters = Type.Object({
  monitorId: Type.String({ minLength: 1 }),
});

const monitorUpdateParameters = Type.Object({
  monitorId: Type.String({ minLength: 1 }),
  current: Type.Optional(Type.Number()),
  total: Type.Optional(Type.Number()),
  message: Type.Optional(Type.String({ maxLength: 1000 })),
});

/** Native settings-only loop/monitor extension. Settings are copied and frozen at creation. */
export function createLoopMonitorDurableExtension(settings: LoopMonitorDurableSettings = {}): Extension {
  const resolved = resolveSettings(settings);

  const loopCreate = defineTool({
    name: "LoopCreate",
    description: "Create a persistent cron/interval or idle loop for recurring checks. Never use shell sleep loops. Event and hybrid triggers are unsupported natively; use cron/interval or idle.",
    parameters: loopCreateParameters,
    // Unsafe: creation admits a new background task, which recovery must not duplicate.
    replay: "unsafe",
    async execute(args, api, context) {
      const params = args as { trigger: string; prompt: string; recurring?: boolean; triggerType?: string; maxFires?: number };
      const extra = args as { event?: unknown; hybrid?: unknown; triggerTypeRaw?: unknown };
      void extra;
      const raw = args as unknown as Record<string, unknown>;
      if (typeof raw["hcTerminalId"] !== "undefined" || typeof raw["onSignal"] !== "undefined") {
        return { isError: true, content: [{ type: "text", text: "LoopCreate: Herdr/event fields are desktop-only and unsupported natively." }] };
      }
      if (params.triggerType !== undefined && params.triggerType !== "cron" && params.triggerType !== "idle") {
        return { isError: true, content: [{ type: "text", text: "LoopCreate: only triggerType \"cron\" or \"idle\" is supported natively. Event and hybrid triggers need the desktop Pi event bus." }] };
      }
      let trigger: LoopTriggerState;
      const trimmed = params.trigger.trim();
      if ((params.triggerType ?? (trimmed.toLowerCase() === "idle" ? "idle" : "cron")) === "idle") {
        if (trimmed.toLowerCase() !== "idle") {
          return { isError: true, content: [{ type: "text", text: "LoopCreate: idle loops require trigger \"idle\"." }] };
        }
        trigger = { type: "dynamic" };
      } else {
        let schedule: string;
        try {
          schedule = parseInterval(trimmed).cron;
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: `LoopCreate: ${boundText(error instanceof Error ? error.message : String(error), 500)}` }] };
        }
        if (!isValidCronExpression(schedule)) {
          return { isError: true, content: [{ type: "text", text: `LoopCreate: invalid cron expression "${boundText(schedule, 120)}".` }] };
        }
        trigger = { type: "cron", schedule };
      }
      if (params.maxFires !== undefined && (!Number.isInteger(params.maxFires) || params.maxFires < 1)) {
        return { isError: true, content: [{ type: "text", text: "LoopCreate: maxFires must be an integer >= 1." }] };
      }
      const live = await readDoc(api, context);
      if (live && Object.keys(live.loops).length >= resolved.maxLoops) {
        return { isError: true, content: [{ type: "text", text: `LoopCreate: maximum of ${resolved.maxLoops} loops reached.` }] };
      }
      const now = Date.now();
      // Atomic: task creation and initial record share one commit, so the
      // scheduler can never observe a live task without its record.
      let loopKey: string;
      try {
        loopKey = await api.commit(async (tx) => {
          const taskId = await tx.createTask(
            LoopTask,
            {
              prompt: params.prompt,
              trigger,
              recurring: params.recurring ?? true,
              ...(params.maxFires !== undefined ? { maxFires: params.maxFires } : {}),
              expiresAt: now + resolved.loopLifetimeMs,
            },
            { ownership: { kind: "conversation" }, background: true, conversationId: api.conversationId },
          );
          const key = String(taskId);
          const draft = await tx.doc(LoopMonitorDoc, api.conversationId);
          const loops = draft.loops as Record<string, LoopRecordState>;
          loops[key] = {
            prompt: params.prompt,
            trigger,
            status: "active",
            recurring: params.recurring ?? true,
            fireCount: 0,
            ...(params.maxFires !== undefined ? { maxFires: params.maxFires } : {}),
            expiresAt: now + resolved.loopLifetimeMs,
            createdAt: now,
            updatedAt: now,
            ...(trigger.type === "dynamic" ? { awaitingUpdate: false, iteration: 0 } : {}),
          };
          return key;
        }, context);
      } catch (error: unknown) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      return {
        content: [{ type: "text", text: `Loop ${loopKey} created (${trigger.type === "dynamic" ? "idle-driven" : trigger.schedule}). ID ${loopKey} persists until explicitly canceled.` }],
        details: { loopId: loopKey },
      };
    },
  });

  const loopList = defineTool({
    name: "LoopList",
    description: "List loop records plus live durable task status. Use before create/delete.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const state = await readDoc(api, context);
      const entries = state ? Object.entries(state.loops) : [];
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No loops configured. Use LoopCreate to set up a schedule." }] };
      }
      const lines: string[] = [];
      for (const [id, entry] of entries) {
        let live = "unknown";
        try {
          const record = await api.getTask(Number(id) as TaskId, context);
          const status = (record as { state?: { status?: string } } | undefined)?.state?.status;
          live = status ?? "unknown";
        } catch {
          live = "unknown";
        }
        const triggerDesc = entry.trigger.type === "dynamic" ? "dynamic" : `cron: ${entry.trigger.schedule}`;
        lines.push(`#${id} [${entry.status}/live:${live}] ${entry.prompt.slice(0, 60)} (${triggerDesc}) fires:${entry.fireCount}${entry.maxFires !== undefined ? `/${entry.maxFires}` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  const loopUpdate = defineTool({
    name: "LoopUpdate",
    description: "Update an idle/dynamic loop once per wake. Use continue with optional nextInterval while work remains; completed only when done; paused only for a genuine blocker.",
    parameters: loopUpdateParameters,
    replay: "safe",
    async execute(args, api, context) {
      const params = args as { id: string; status: string; state?: string; metrics?: string; doneCriteria?: string; nextInterval?: string; prompt?: string };
      const updated = await api.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, api.conversationId);
        const loops = draft.loops as Record<string, LoopRecordState>;
        const current = loops[params.id];
        if (!current) return { ok: false as const, message: `Loop #${params.id} not found.` };
        if (current.trigger.type !== "dynamic") return { ok: false as const, message: `Loop #${params.id} is not a dynamic loop.` };
        if (current.status !== "active" && current.status !== "paused") {
          return { ok: false as const, message: `Loop #${params.id} is ${current.status}; recreate it explicitly.` };
        }
        if (params.status === "continue") {
          let nextWakeAt: number | undefined;
          if (params.nextInterval !== undefined) {
            const delay = parseDelayMs(params.nextInterval);
            if (!delay) return { ok: false as const, message: `Invalid nextInterval "${params.nextInterval}". Use formats like 3m, 30s, or 1h.` };
            nextWakeAt = Date.now() + delay;
            if (nextWakeAt >= current.expiresAt) {
              return { ok: false as const, message: `nextInterval exceeds loop #${params.id}'s remaining lifetime.` };
            }
          }
          current.status = "active";
          current.awaitingUpdate = false;
          if (nextWakeAt !== undefined) current.nextWakeAt = nextWakeAt;
          else delete current.nextWakeAt;
          if (params.prompt !== undefined) current.prompt = params.prompt;
          if (params.state !== undefined) current.state = params.state;
          if (params.metrics !== undefined) current.metrics = params.metrics;
          if (params.doneCriteria !== undefined) current.doneCriteria = params.doneCriteria;
          current.iteration = (current.iteration ?? 0) + 1;
          current.updatedAt = Date.now();
          return { ok: true as const, message: `Dynamic loop #${params.id} updated (iteration ${current.iteration}).` };
        }
        current.status = params.status === "completed" ? "completed" : "paused";
        current.updatedAt = Date.now();
        return { ok: true as const, message: params.status === "completed" ? `Dynamic loop #${params.id} completed.` : `Dynamic loop #${params.id} paused.` };
      }, context);
      if (!updated.ok) return { isError: true, content: [{ type: "text", text: updated.message }] };
      return { content: [{ type: "text", text: updated.message }] };
    },
  });

  const loopDelete = defineTool({
    name: "LoopDelete",
    description: "Pause or delete a loop. Paused and deleted loops are terminal natively; recreate explicitly to run again. Never claims the task stopped unless its terminal receipt confirms it.",
    parameters: loopDeleteParameters,
    replay: "safe",
    async execute(args, api, context) {
      const params = args as { id: string; action?: string };
      const action = params.action ?? "delete";
      const taskId = Number(params.id) as TaskId;
      const existing = await readDoc(api, context);
      if (!existing?.loops[params.id]) {
        return { isError: true, content: [{ type: "text", text: `Loop #${params.id} not found.` }] };
      }
      await api.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, api.conversationId);
        const loops = draft.loops as Record<string, LoopRecordState>;
        if (action === "pause") {
          const current = loops[params.id];
          if (current) {
            current.status = "paused";
            current.updatedAt = Date.now();
          }
        } else {
          delete loops[params.id];
        }
        return undefined;
      }, context);
      try {
        await api.waitForTask(taskId, context);
      } catch {
        const after = await readDoc(api, context).catch(() => undefined);
        const stillActive = after?.loops[params.id]?.status === "active";
        if (stillActive) {
          return { isError: true, content: [{ type: "text", text: `Loop #${params.id} is still active; inspect LoopList and retry.` }] };
        }
      }
      return { content: [{ type: "text", text: action === "pause" ? `Loop #${params.id} paused.` : `Loop #${params.id} deleted.` }] };
    },
  });

  const monitorCreate = defineTool({
    name: "MonitorCreate",
    description: "Run a shell command in a background conversation-owned monitor task. Use MonitorList for status; do not poll with shell sleep loops. The timeout measures inactivity, not total runtime.",
    parameters: monitorCreateParameters,
    // Unsafe: creation admits a new background command, which recovery must not duplicate.
    replay: "unsafe",
    async execute(args, api, context) {
      const params = args as { command: string; description?: string; timeout?: number; onDone?: string };
      const raw = args as unknown as Record<string, unknown>;
      if (raw["hcTerminalId"] !== undefined || raw["onSignal"] !== undefined) {
        return { isError: true, content: [{ type: "text", text: "MonitorCreate: hcTerminalId/onSignal are desktop-only and unsupported natively. Pass a shell command instead." }] };
      }
      if (!params.command.trim()) {
        return { isError: true, content: [{ type: "text", text: "MonitorCreate: command must be non-empty." }] };
      }
      const timeoutMs = params.timeout ?? resolved.defaultMonitorTimeoutMs;
      if (!isFiniteNumber(timeoutMs) || timeoutMs < 0 || timeoutMs > resolved.maxMonitorTimeoutMs) {
        return { isError: true, content: [{ type: "text", text: `MonitorCreate: timeout must be 0..${resolved.maxMonitorTimeoutMs}.` }] };
      }
      const live = await readDoc(api, context);
      const running = live ? Object.values(live.monitors).filter((entry) => entry.status === "running" || entry.status === "starting").length : 0;
      if (running >= resolved.maxMonitors) {
        return { isError: true, content: [{ type: "text", text: `MonitorCreate: maximum of ${resolved.maxMonitors} running monitors reached.` }] };
      }
      const now = Date.now();
      // Atomic: task creation and initial record share one commit, so the
      // scheduler can never observe a live task without its record.
      let monitorKey: string;
      try {
        monitorKey = await api.commit(async (tx) => {
          const taskId = await tx.createTask(
            MonitorTask,
            {
              command: params.command,
              ...(params.description !== undefined ? { description: params.description } : {}),
              timeoutMs,
              ...(params.onDone !== undefined ? { onDone: params.onDone } : {}),
              maxOutputLines: resolved.maxOutputLines,
              maxOutputLineChars: resolved.maxOutputLineChars,
              outputCommitMs: resolved.outputCommitMs,
            },
            { ownership: { kind: "conversation" }, background: true, conversationId: api.conversationId },
          );
          const key = String(taskId);
          const draft = await tx.doc(LoopMonitorDoc, api.conversationId);
          const monitors = draft.monitors as Record<string, MonitorRecordState>;
          monitors[key] = {
            command: params.command,
            ...(params.description !== undefined ? { description: params.description } : {}),
            status: "starting",
            outputLines: 0,
            outputTail: [],
            stopRequested: false,
            timeoutMs,
            ...(params.onDone !== undefined ? { onDone: params.onDone } : {}),
            lastActivityAt: now,
            createdAt: now,
            updatedAt: now,
          };
          return key;
        }, context);
      } catch (error: unknown) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      return {
        content: [{ type: "text", text: `Monitor ${monitorKey} started: ${params.command.slice(0, 60)}\nInactivity timeout: ${timeoutMs > 0 ? `${timeoutMs / 1000}s` : "none"}` }],
        details: { monitorId: monitorKey },
      };
    },
  });

  const monitorList = defineTool({
    name: "MonitorList",
    description: "List monitors with live task status, exit code, output line count, and bounded output tail.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const state = await readDoc(api, context);
      const entries = state ? Object.entries(state.monitors) : [];
      if (entries.length === 0) return { content: [{ type: "text", text: "No monitors." }] };
      const lines: string[] = [];
      for (const [id, entry] of entries) {
        let live = "unknown";
        try {
          const record = await api.getTask(Number(id) as TaskId, context);
          live = ((record as { state?: { status?: string } } | undefined)?.state?.status ?? "unknown");
        } catch {
          live = "unknown";
        }
        let line = `#${id} [${entry.status}/live:${live}] ${entry.command.slice(0, 60)} — ${entry.outputLines} lines`;
        if (entry.exitCode !== undefined) line += ` exit=${entry.exitCode}`;
        if (entry.stopReason) line += ` reason=${entry.stopReason}`;
        if (entry.progress) line += ` · ${formatProgress(entry.progress)}`;
        lines.push(line);
        for (const out of entry.outputTail.slice(-5)) lines.push(`  | ${out.slice(0, 100)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  const monitorUpdate = defineTool({
    name: "MonitorUpdate",
    description: "Set trustworthy structured progress for a running monitor. This renews its inactivity timeout. Do not use it for raw output or polling.",
    parameters: monitorUpdateParameters,
    replay: "safe",
    async execute(args, api, context) {
      const params = args as { monitorId: string; current?: number; total?: number; message?: string };
      if (params.current !== undefined && !isFiniteNumber(params.current)) {
        return { isError: true, content: [{ type: "text", text: "MonitorUpdate: current must be a finite number." }] };
      }
      if (params.total !== undefined && !isFiniteNumber(params.total)) {
        return { isError: true, content: [{ type: "text", text: "MonitorUpdate: total must be a finite number." }] };
      }
      const updated = await api.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, api.conversationId);
        const monitors = draft.monitors as Record<string, MonitorRecordState>;
        const current = monitors[params.monitorId];
        if (!current || (current.status !== "running" && current.status !== "starting")) return undefined;
        current.progress = {
          ...(params.current !== undefined ? { current: params.current } : {}),
          ...(params.total !== undefined ? { total: params.total } : {}),
          ...(params.message !== undefined ? { message: params.message } : {}),
        };
        current.lastActivityAt = Date.now();
        current.updatedAt = Date.now();
        return current.progress;
      }, context);
      if (!updated) {
        return { isError: true, content: [{ type: "text", text: `Monitor #${params.monitorId} not found or not running.` }] };
      }
      return { content: [{ type: "text", text: `Monitor #${params.monitorId} progress updated: ${formatProgress(updated)}` }] };
    },
  });

  const monitorStop = defineTool({
    name: "MonitorStop",
    description: "Stop a running monitor. Reports the actual terminal status; never claims a lost process is still running.",
    parameters: monitorIdParameters,
    replay: "safe",
    async execute(args, api, context) {
      const params = args as { monitorId: string };
      const before = (await readDoc(api, context))?.monitors[params.monitorId];
      if (!before) return { isError: true, content: [{ type: "text", text: `Monitor #${params.monitorId} not found.` }] };
      const wasRunning = before.status === "running" || before.status === "starting";
      await api.commit(async (tx) => {
        const draft = await tx.doc(LoopMonitorDoc, api.conversationId);
        const monitors = draft.monitors as Record<string, MonitorRecordState>;
        const current = monitors[params.monitorId];
        if (current && (current.status === "running" || current.status === "starting")) {
          current.stopRequested = true;
          current.updatedAt = Date.now();
        }
        return undefined;
      }, context);
      try {
        await api.waitForTask(Number(params.monitorId) as TaskId, context);
      } catch {
        const after = await readDoc(api, context).catch(() => undefined);
        const current = after?.monitors[params.monitorId];
        if (current && (current.status === "running" || current.status === "starting")) {
          return { isError: true, content: [{ type: "text", text: `Monitor #${params.monitorId} is still ${current.status}; inspect MonitorList and retry.` }] };
        }
      }
      const after = await readDoc(api, context);
      const current = after?.monitors[params.monitorId];
      if (!wasRunning) {
        return { content: [{ type: "text", text: `Monitor #${params.monitorId} was already ${before.status}; ${current ? `now ${current.status}` : "record retired"}.` }] };
      }
      return { content: [{ type: "text", text: `Monitor #${params.monitorId} stopped (now ${current?.status ?? "unknown"}).` }] };
    },
  });

  return defineExtension({
    name: LOOP_MONITOR_DURABLE_EXTENSION_NAME,
    tools: [loopCreate, loopList, loopUpdate, loopDelete, monitorCreate, monitorList, monitorUpdate, monitorStop],
    tasks: [LoopTask, MonitorTask],
  });
}
