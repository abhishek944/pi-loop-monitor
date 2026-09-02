import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  constructor(private store: LoopStore, private monitorManager: MonitorManager) {}
  setUICtx(ctx: ExtensionUIContext) { this.uiCtx = ctx; }
  setStore(store: LoopStore) { this.store = store; }
  update() { if (this.uiCtx) this.uiCtx.setStatus("loops", this.computeStatus()); }
  private computeStatus(): string | undefined {
    const loops = this.store.list().filter(isStatusVisibleLoop);
    const monitors = this.monitorManager.list().filter((monitor) => monitor.status === "running");
    if (!loops.length && !monitors.length) return undefined;
    const parts: string[] = [];
    if (loops.length) parts.push(`↻ ${formatCount(loops.length, "loop")}`);
    if (monitors.length) parts.push(`▶ ${formatCount(monitors.length, "monitor")}`);
    let line = parts.join(" · ");
    const monitor = monitors.length === 1 ? monitors[0] : undefined;
    if (monitor) { const activity = formatMonitorActivity(monitor); if (activity) line += ` | ${activity}`; }
    return line;
  }
  dispose() { this.uiCtx?.setStatus("loops", undefined); }
}
function formatMonitorActivity(monitor: { progress?: { current?: number; total?: number; message?: string; updatedAt?: number }; startedAt: number; lastActivityAt?: number; lastOutputAt?: number; outputRatePerMinute?: number }): string | undefined {
  const progress = monitor.progress?.current !== undefined && monitor.progress.total ? `${Math.round((monitor.progress.current / monitor.progress.total) * 100)}%` : monitor.progress?.message;
  const now = Date.now();
  const silence = now - Math.max(monitor.startedAt, monitor.lastActivityAt ?? 0, monitor.lastOutputAt ?? 0, monitor.progress?.updatedAt ?? 0);
  const activity = silence >= 60000 ? `quiet ${Math.round(silence / 60000)}m` : monitor.lastOutputAt !== undefined && now - monitor.lastOutputAt < 60000 && monitor.outputRatePerMinute !== undefined ? `${monitor.outputRatePerMinute} lines/min` : undefined;
  return [progress, activity].filter(Boolean).join(" · ") || undefined;
}
function formatCount(count: number, noun: string) { return `${count} ${noun}${count === 1 ? "" : "s"}`; }
function isStatusVisibleLoop(loop: LoopEntry): boolean { return loop.status === "active" && (loop.recurring || !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done")); }
