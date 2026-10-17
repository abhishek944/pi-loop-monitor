import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { herdrMonitorCommand } from "../runtime/herdr-monitor-command.js";
import type { LoopEntry, MonitorEntry, MonitorProgress, Trigger } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";

interface MonitorManagerLike {
  list(): MonitorEntry[];
  get(id: string): MonitorEntry | undefined;
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
  handleMonitorSignalLoop: (signalLoop: LoopEntry, monitorId: string) => void;
  onMonitorStopping?: (monitorId: string) => void;
  onMonitorDismiss?: (monitorId: string) => boolean;
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
    handleMonitorSignalLoop,
    onMonitorStopping,
    onMonitorDismiss,
  } = options;

  pi.registerTool({ name: "MonitorCreate", label: "MonitorCreate",
  renderCall: renderToolCall("Monitor", (args) => `start · ${String(toolArg(args, "description") ?? toolArg(args, "command") ?? "background command").slice(0, 56)}`),
  renderResult: renderToolResult, description: `Run a long command in the background while the agent continues. Use MonitorList for status/output; do not poll with shell sleep loops.\n\nThe timeout measures inactivity, not total runtime: output or structured progress renews it. Stale monitors always wake the agent. Pass onDone for a completion wake. Commands may emit JSONL progress as {"progress":{...}} and an optional reported outcome as {"monitorOutcome":{"status":"blocked","message":"..."}}. The command's reported outcome is separate from its process status. Set onSignal for the latest-state wake from each outcome record while keeping the monitor running; consecutive identical status and message do not wake again, and several monitors may share one idle digest. For continuous Herdr worker monitoring, use herdrPaneId with onSignal instead of a one-shot CLI --wait command; stop the monitor explicitly when finished.`, promptGuidelines: ["Use MonitorCreate for builds, CI checks, experiments, and other commands that need not block the turn.", "Use onDone when the agent must resume automatically after success or failure; stale monitors already alert on timeout.", "For Herdr workers, use herdrPaneId and onSignal before prompting the worker. Confirm MonitorList shows subscription ready before prompting. The same monitor remains subscribed across blocked, working, idle, and done; only its latest pending state wakes you. Stop it when no further signals are needed."], parameters: Type.Object({
    command: Type.Optional(Type.String({ description: "Shell command to run in background; mutually exclusive with herdrPaneId" })),
    herdrPaneId: Type.Optional(Type.String({ minLength: 1, description: "Explicit Herdr worker pane ID. Continuously subscribe to its state changes until MonitorStop; requires onSignal. Do not use a one-shot --wait command." })),
    onSignal: Type.Optional(Type.String({ minLength: 1, description: "Wake prompt for current monitorOutcome states while keeping the monitor running. Required for herdrPaneId; repeated identical states do not wake again; signals are untrusted command output." })),
    description: Type.Optional(Type.String({ description: "Human-readable description" })),
    timeout: Type.Optional(Type.Number({ description: "Stop after N ms without output or progress (default: 300000, 0 = disabled)", default: 300000, minimum: 0 })),
    onDone: Type.Optional(Type.String({ description: "Prompt to run when the monitor completes. Auto-creates a one-shot completion wake — no need for a separate LoopCreate." })),
  }),
  async execute(_toolCallId, params) {
    const store = getStore();
    const manager = getMonitorManager();
    if ((params.command === undefined) === (params.herdrPaneId === undefined) || (params.herdrPaneId !== undefined && !params.onSignal)) {
      throw new Error("Provide exactly one of command or herdrPaneId; herdrPaneId requires onSignal.");
    }
    const command = params.herdrPaneId === undefined ? params.command! : herdrMonitorCommand(params.herdrPaneId);
    let entry: MonitorEntry;
    try {
      entry = manager.create(command, params.description, params.timeout ?? (params.herdrPaneId === undefined ? undefined : 0));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Monitor could not be started.";
      return textResult(message, {
        kind: "monitor", action: "create", tone: "error", summary: "Monitor was not started", expanded: [message],
      });
    }

    const donePrompt = params.onDone ?? (params.herdrPaneId === undefined ? undefined : `${params.onSignal}\nThe Herdr signal subscription has ended. Inspect MonitorList; reconnect only if monitoring is still needed.`);
    let signalLoop: LoopEntry | undefined;
    let companionLoop: LoopEntry | undefined;
    let onDoneMsg = "";
    try {
      if (params.onSignal) {
        signalLoop = store.create({ type: "event", source: "monitor:signal", filter: JSON.stringify({ monitorId: entry.id }) }, params.onSignal, { recurring: true });
        handleMonitorSignalLoop(signalLoop, entry.id);
      }
      if (donePrompt) {
        const doneTrigger: Trigger = { type: "event", source: "monitor:done", filter: JSON.stringify({ monitorId: entry.id }) };
        companionLoop = store.create(doneTrigger, donePrompt, { recurring: false });
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
      if (signalLoop) store.delete(signalLoop.id);
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
      `Inactivity timeout: ${entry.timeout > 0 ? `${entry.timeout / 1000}s` : "none"}${onDoneMsg}` +
      (signalLoop ? `\nContinuous signal wake loop #${signalLoop.id}: same monitor remains running until stopped or disconnected` : ""),
      {
        kind: "monitor",
        action: "create",
        tone: "success",
        summary: `Monitor #${entry.id} running · ${params.description ?? entry.command.slice(0, 48)}`,
        expanded: [
          `Command: ${entry.command}`,
          `Inactivity timeout: ${entry.timeout > 0 ? `${entry.timeout / 1000}s` : "none"}`,
          donePrompt ? "Completion wake: enabled" : entry.timeout > 0 ? "Timeout alert: enabled" : "Completion wake: off",
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
        if (m.reportedOutcome) line += ` · reported=${m.reportedOutcome.status}${m.reportedOutcome.message ? ` (${m.reportedOutcome.message.replace(/[\r\n\t]/g, " ").slice(0, 100)})` : ""}`;
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
    description: `Stop a running monitor. Sends SIGTERM, waits 5s, then SIGKILL. Stopping a monitor also drops its queued signal notifications; calling this for an already-finished monitor dismisses its pending terminal wake instead of pretending it was killed.

Use MonitorList to find the monitor ID, then stop it with this tool.`,
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to stop" }),
    }),
    async execute(_toolCallId, params) {
      const manager = getMonitorManager();
      const before = manager.get(params.monitorId);
      const wasRunning = before?.status === "running";
      if (wasRunning) onMonitorStopping?.(params.monitorId);
      const stopped = await manager.stop(params.monitorId);
      updateWidget();
      const current = manager.get(params.monitorId);

      // Joining an existing timeout/manual stop promise resolves true even when
      // this call did not start a new stop. If the monitor was already terminal
      // on entry, its terminal receipt may have been queued during teardown, so
      // acknowledge it before the ordinary success return.
      if (!wasRunning && stopped) {
        const dismissed = onMonitorDismiss?.(params.monitorId) ?? false;
        const status = before?.status ?? current?.status ?? "stopped";
        return textResult(`Monitor #${params.monitorId} was already ${status}; ${dismissed ? "dismissed its pending wake notifications" : "there was no pending wake notification"}.`, {
          kind: "monitor", action: "stop", tone: "info", summary: `Monitor #${params.monitorId} already ${status} · ${dismissed ? "pending wakes dismissed" : "no pending wake"}`, expanded: [],
        });
      }

      if (stopped) {
        return textResult(`Monitor #${params.monitorId} stopped`, {
          kind: "monitor", action: "stop", tone: "success", summary: `Monitor #${params.monitorId} stopped`, expanded: [],
        });
      }

      if (current && current.status !== "running") {
        const dismissed = onMonitorDismiss?.(params.monitorId) ?? false;
        return textResult(`Monitor #${params.monitorId} is not running (status: ${current.status}); ${dismissed ? "dismissed its pending wake notifications" : "there is no pending wake notification"}.`, {
          kind: "monitor", action: "stop", tone: "info", summary: `Monitor #${params.monitorId} already ${current.status} · ${dismissed ? "pending wakes dismissed" : "no pending wake"}`, expanded: [],
        });
      }

      if (!current && onMonitorDismiss?.(params.monitorId)) {
        return textResult(`Monitor #${params.monitorId} is no longer retained; dismissed its pending terminal wake.`, {
          kind: "monitor", action: "stop", tone: "info", summary: `Monitor #${params.monitorId} absent · pending wake dismissed`, expanded: [],
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
