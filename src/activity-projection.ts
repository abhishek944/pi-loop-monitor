import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MonitorManager } from "./monitor-manager.js";
import type { LoopStore } from "./store.js";

/** A disposable display projection, never an input to the scheduler or process manager. */
export class ActivityProjection {
  private sessionId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentPath: string | undefined;
  private lastWrite = 0;
  constructor(
    private runtimeId: string,
    private getStore: () => LoopStore,
    private monitors: MonitorManager,
    private isCurrent: () => boolean,
  ) {}
  get path(): string | undefined { return this.currentPath; }

  bind(sessionId: string | undefined): void {
    if (sessionId === this.sessionId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sessionId) {
      this.publish(false);
      // This runtime's view data is temporary; retained native rows become last-known.
      if (this.currentPath) try { unlinkSync(this.currentPath); } catch { /* best-effort disposal */ }
    }
    this.sessionId = sessionId && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId) ? sessionId : undefined;
    this.currentPath = this.sessionId ? join(homedir(), ".pi", "loops", `activity-${this.sessionId}-${this.runtimeId}.json`) : undefined;
    this.lastWrite = 0;
    if (this.sessionId) this.schedule();
  }

  schedule(): void {
    if (!this.sessionId || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { if (this.isCurrent()) this.publish(true); }
      catch { /* A display-only callback must never interrupt monitoring. */ }
    }, Math.max(0, 1000 - (Date.now() - this.lastWrite)));
    this.timer.unref?.();
  }

  /** Explicit opener flush. A failed publication does not claim a usable binding. */
  flush(): string | undefined {
    if (!this.sessionId || !this.isCurrent()) return undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.publish(true) ? this.currentPath : undefined;
  }

  private publish(live: boolean): boolean {
    if (!this.sessionId || !this.currentPath) return false;
    const now = Date.now();
    const display = (() => {
      if (!live) return { loops: [], monitors: [], omittedMonitors: 0, error: undefined };
      try {
        const monitors = this.monitors.list();
        const running = monitors.filter((entry) => entry.status === "running");
        const visible = [...running, ...monitors.filter((entry) => entry.status !== "running").slice(-(100 - running.length))]
          .sort((a, b) => Number(a.id) - Number(b.id));
        return {
          loops: this.getStore().list(),
          monitors: visible.map((entry) => ({
            id: entry.id, command: entry.command, description: entry.description,
            status: entry.status, startedAt: entry.startedAt, completedAt: entry.completedAt,
            exitCode: entry.exitCode, stopReason: entry.stopReason, reportedOutcome: entry.reportedOutcome,
            // Captured logical lines are bounded by MonitorManager; no full-log read/transport.
            output: entry.outputBuffer.slice(-3), subscription: entry.hcTerminalId !== undefined,
          })),
          omittedMonitors: monitors.length - visible.length, error: undefined,
        };
      } catch {
        return { loops: [], monitors: [], omittedMonitors: 0, error: "Activity source unavailable. Use /monitors in Pi." };
      }
    })();
    const value = {
      version: 1, source: "pi-loop-monitor", sessionId: this.sessionId,
      runtimeId: this.runtimeId, pid: process.pid, terminal: process.env.HC_TERMINAL_ID ?? null,
      updatedAt: now, live: live && display.error === undefined, ...display,
    };
    const temporary = `${this.currentPath}.tmp`;
    try {
      mkdirSync(join(homedir(), ".pi", "loops"), { recursive: true, mode: 0o700 });
      let contents = JSON.stringify(value);
      const oversized = Buffer.byteLength(contents) > 4 * 1024 * 1024;
      if (oversized) {
        contents = JSON.stringify({ ...value, loops: [], monitors: [], error: "Activity display exceeds 4 MiB. Use /monitors in Pi." });
      }
      writeFileSync(temporary, contents, { mode: 0o600 });
      renameSync(temporary, this.currentPath);
      this.lastWrite = now;
      return !oversized && display.error === undefined;
    } catch {
      try { unlinkSync(temporary); } catch { /* best-effort projection only */ }
      return false;
    }
  }
}
