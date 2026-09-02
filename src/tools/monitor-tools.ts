import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopEntry, MonitorEntry, MonitorProgress, Trigger } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";

interface MonitorManagerLike {
  list(): MonitorEntry[];
  create(command: string, description?: string, timeout?: number): MonitorEntry;
  stop(id: string): Promise<boolean>;
  updateProgress(id: string, progress: Omit<MonitorProgress, "source" | "updatedAt">): MonitorEntry | undefined;
}

interface LoopStoreLike {
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    readOnly?: boolean;
    maxFires?: number;
  }): LoopEntry;
  delete(id: string): boolean;
}

export interface MonitorToolsOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getMonitorManager: () => MonitorManagerLike;
  updateWidget: () => void;
  handleMonitorDoneLoop: (doneLoop: LoopEntry, monitorId: string) => void;
}

function formatRemaining(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function formatActivity(monitor: MonitorEntry): string | undefined {
  const now = Date.now();
  const lastActivityAt = Math.max(
    monitor.startedAt,
    monitor.lastActivityAt ?? 0,
    monitor.lastOutputAt ?? 0,
    monitor.progress?.updatedAt ?? 0,
  );
  const silence = now - lastActivityAt;
  if (silence >= 60000) return `quiet ${formatRemaining(silence)}`;
  if (monitor.lastOutputAt !== undefined && now - monitor.lastOutputAt < 60000 && monitor.outputRatePerMinute !== undefined) {
    return `${monitor.outputRatePerMinute} lines/min`;
  }
  return undefined;
}

export function registerMonitorTools(options: MonitorToolsOptions): void {
  const {
    pi,
    getStore,
    getMonitorManager,
    updateWidget,
    handleMonitorDoneLoop,
  } = options;

  pi.registerTool({ name: "MonitorCreate", label: "MonitorCreate",
  renderCall: renderToolCall("Monitor", (args) => `start · ${String(toolArg(args, "description") ?? toolArg(args, "command") ?? "background command").slice(0, 56)}`),
  renderResult: renderToolResult, description: `Run a long command in the background while the agent continues. Use MonitorList for status/output; do not poll with shell sleep loops.\n\nThe timeout measures inactivity, not total runtime: output or structured progress renews it. Stale monitors always wake the agent. Pass onDone for a completion wake. Commands may emit JSONL progress as {"progress":{...}}; otherwise use MonitorUpdate.`, promptGuidelines: ["Use MonitorCreate for builds, CI checks, experiments, and other commands that need not block the turn.", "Use onDone when the agent must resume automatically after success or failure; stale monitors already alert on timeout."], parameters: Type.Object({
    command: Type.String({ description: "Shell command to run in background" }),
    description: Type.Optional(Type.String({ description: "Human-readable description" })),
    timeout: Type.Optional(Type.Number({ description: "Stop after N ms without output or progress (default: 300000, 0 = disabled)", default: 300000, minimum: 0 })),
    onDone: Type.Optional(Type.String({ description: "Prompt to run when the monitor completes. Auto-creates a one-shot completion wake — no need for a separate LoopCreate." })),
  }),
  async execute(_toolCallId, params) {
    const store = getStore();
    const manager = getMonitorManager();
    let entry: MonitorEntry;
    try {
      entry = manager.create(params.command, params.description, params.timeout);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Monitor could not be started.";
      return textResult(message, {
        kind: "monitor", action: "create", tone: "error", summary: "Monitor was not started", expanded: [message],
      });
    }

    let companionLoop: LoopEntry | undefined;
    let onDoneMsg = "";
    try {
      if (params.onDone) {
        const doneTrigger: Trigger = { type: "event", source: "monitor:done", filter: JSON.stringify({ monitorId: entry.id }) };
        companionLoop = store.create(doneTrigger, params.onDone, { recurring: false });
        handleMonitorDoneLoop(companionLoop, entry.id);
        onDoneMsg = `\nCompletion wake loop #${companionLoop.id}: fires when the monitor completes — no polling needed`;
      } else if (entry.timeout > 0) {
        const timeoutTrigger: Trigger = { type: "event", source: "monitor:timeout", filter: JSON.stringify({ monitorId: entry.id }) };
        companionLoop = store.create(
          timeoutTrigger,
          `Monitor #${entry.id} became stale after ${entry.timeout}ms without output or progress. Inspect MonitorList, report the failure, and decide whether to retry or recover the command.`,
          { recurring: false },
        );
        handleMonitorDoneLoop(companionLoop, entry.id);
        onDoneMsg = `\nTimeout alert loop #${companionLoop.id}: wakes the agent only if the monitor times out`;
      }
    } catch (error) {
      if (companionLoop) store.delete(companionLoop.id);
      await manager.stop(entry.id);
      updateWidget();
      const detail = error instanceof Error ? error.message : "completion wake setup failed";
      return textResult(`Monitor #${entry.id} was stopped because its completion wake could not be created: ${detail}`, {
        kind: "monitor", action: "create", tone: "error", summary: `Monitor #${entry.id} setup rolled back`, expanded: [detail],
      });
    }
    updateWidget();

    return textResult(
      `Monitor #${entry.id} started: ${entry.command.slice(0, 60)}\n` +
      `Progress: MonitorList shows the live output tail; monitor:output is rate-limited (monitorId: ${entry.id})\n` +
      `Inactivity timeout: ${entry.timeout > 0 ? `${entry.timeout / 1000}s` : "none"}${onDoneMsg}`,
      {
        kind: "monitor",
        action: "create",
        tone: "success",
        summary: `Monitor #${entry.id} running · ${params.description ?? entry.command.slice(0, 48)}`,
        expanded: [
          `Command: ${entry.command}`,
          `Inactivity timeout: ${entry.timeout > 0 ? `${entry.timeout / 1000}s` : "none"}`,
          params.onDone ? "Completion wake: enabled" : entry.timeout > 0 ? "Timeout alert: enabled" : "Completion wake: off",
        ],
      },
    );
  }, });

  pi.registerTool({
    name: "MonitorList",
    label: "MonitorList",
    renderCall: renderToolCall("Monitor", () => "status"),
    renderResult: renderToolResult,
    description: "List all monitors with their status, command, exit code, output line count, and last 5 lines of buffered output.",
    parameters: Type.Object({}),
    execute() {
      const monitors = getMonitorManager().list();
      if (monitors.length === 0) {
        return Promise.resolve(textResult("No monitors.", {
          kind: "monitor", action: "list", tone: "info", summary: "No monitors", expanded: ["Use MonitorCreate for long-running background work."],
        }));
      }

      const lines: string[] = [];
      for (const m of monitors) {
        const icon = m.status === "running" ? ">" : m.status === "completed" ? "ok" : "x";
        const age = Date.now() - m.startedAt;
        const ageStr = formatRemaining(age);
        let line = `${icon} #${m.id} [${m.status}] ${m.command.slice(0, 60)} — ${m.outputLines} lines (${ageStr})`;
        if (m.exitCode !== undefined) line += ` exit=${m.exitCode}`;
        if (m.stopReason) line += ` reason=${m.stopReason}`;
        if (m.progress) line += ` · ${formatProgress(m.progress)}`;
        const activity = m.status === "running" ? formatActivity(m) : undefined;
        if (activity) line += ` · ${activity}`;
        lines.push(line);

        if (m.outputBuffer.length > 0) {
          const tail = m.outputBuffer.slice(-5);
          for (const out of tail) {
            lines.push(`  | ${out.slice(0, 100)}`);
          }
        }
      }

      const running = monitors.filter((monitor) => monitor.status === "running").length;
      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "monitor",
        action: "list",
        tone: "info",
        summary: `${monitors.length} monitor${monitors.length === 1 ? "" : "s"} · ${running} running`,
        expanded: displayRows(lines),
      }));
    },
  });

  pi.registerTool({
    name: "MonitorUpdate",
    label: "MonitorUpdate",
    renderCall: renderToolCall("Monitor", (args) => `update · #${String(toolArg(args, "monitorId") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Set trustworthy structured progress for a running monitor that cannot emit JSONL. This renews its inactivity timeout. Pass monitorId and current/total or message. Do not use it for raw output or polling; use MonitorList.",
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to update" }),
      current: Type.Optional(Type.Number({ description: "Completed work units" })),
      total: Type.Optional(Type.Number({ description: "Total work units" })),
      message: Type.Optional(Type.String({ description: "Short progress status" })),
    }, { additionalProperties: false, minProperties: 2 }),
    execute(_toolCallId, params) {
      const entry = getMonitorManager().updateProgress(params.monitorId, {
        current: params.current,
        total: params.total,
        message: params.message,
      });
      if (!entry) {
        return Promise.resolve(textResult(`Monitor #${params.monitorId} not found or not running`, {
          kind: "monitor", action: "update", tone: "error", summary: `Monitor #${params.monitorId} unavailable`, expanded: [],
        }));
      }
      updateWidget();
      return Promise.resolve(textResult(`Monitor #${entry.id} progress updated: ${formatProgress(entry.progress!)}`, {
        kind: "monitor", action: "update", tone: "success", summary: `Monitor #${entry.id} · ${formatProgress(entry.progress!)}`, expanded: [],
      }));
    },
  });

  pi.registerTool({
    name: "MonitorStop",
    label: "MonitorStop",
    renderCall: renderToolCall("Monitor", (args) => `stop · #${String(toolArg(args, "monitorId") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Stop a running monitor. Sends SIGTERM, waits 5s, then SIGKILL.

Use MonitorList to find the monitor ID, then stop it with this tool.`,
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to stop" }),
    }),
    async execute(_toolCallId, params) {
      const stopped = await getMonitorManager().stop(params.monitorId);
      updateWidget();
      if (stopped) {
        return textResult(`Monitor #${params.monitorId} stopped`, {
          kind: "monitor", action: "stop", tone: "success", summary: `Monitor #${params.monitorId} stopped`, expanded: [],
        });
      }

      return textResult(`Monitor #${params.monitorId} not found or not running`, {
        kind: "monitor", action: "stop", tone: "error", summary: `Monitor #${params.monitorId} unavailable`, expanded: ["Use MonitorList to find running monitor IDs."],
      });
    },
  });
}

function formatProgress(progress: MonitorProgress): string {
  const ratio = progress.current !== undefined && progress.total !== undefined && progress.total > 0
    ? `${Math.round((progress.current / progress.total) * 100)}% (${progress.current}/${progress.total})`
    : progress.current !== undefined
      ? String(progress.current)
      : "";
  return [ratio, progress.message].filter(Boolean).join(" · ") || "updated";
}
