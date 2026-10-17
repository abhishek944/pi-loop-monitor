import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";
import { MonitorsDashboard } from "../ui/monitors-dashboard.js";
import { runMonitorsOverlay } from "../ui/overlay.js";

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface MonitorsCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStore;
  getMonitorManager: () => MonitorManager;
  getTriggerSystem: () => TriggerSystemLike;
  updateWidget: () => void;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
  onLoopStopped?: (loopId: string) => void;
  onMonitorStopping?: (monitorId: string) => void;
}

export function registerMonitorsCommand(options: MonitorsCommandOptions): void {
  const {
    pi,
    getStore,
    getMonitorManager,
    getTriggerSystem,
    updateWidget,
    onDynamicLoopActivated,
    onLoopStopped,
    onMonitorStopping,
  } = options;
  let closeActiveDashboard: (() => void) | undefined;
  const refreshWidget = () => {
    try { updateWidget(); } catch { /* dashboard actions remain authoritative */ }
  };

  pi.on("session_shutdown", () => {
    closeActiveDashboard?.();
    closeActiveDashboard = undefined;
  });

  pi.registerCommand("monitors", {
    description: "Open the loops and background monitors dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        throw new Error("/monitors requires interactive TUI mode");
      }

      let commandClose: (() => void) | undefined;
      try {
        closeActiveDashboard?.();
        await runMonitorsOverlay(ctx, (tui, theme, keybindings, close) => {
          const closeCurrent = () => {
            if (closeActiveDashboard === closeCurrent) closeActiveDashboard = undefined;
            close();
          };
          commandClose = closeCurrent;
          closeActiveDashboard = closeCurrent;
          return new MonitorsDashboard(tui, theme, keybindings, {
            listLoops: () => getStore().list(),
            listMonitors: () => getMonitorManager().list(),
            readMonitorOutput: (id, offset) => getMonitorManager().readOutput(id, offset),
            pauseLoop: (id) => {
              const entry = getStore().get(id);
              if (entry?.status !== "active") return false;
              const paused = getStore().pause(id);
              if (!paused) return false;
              try { getTriggerSystem().remove(id); } catch { /* paused state remains authoritative */ }
              onLoopStopped?.(id);
              refreshWidget();
              return true;
            },
            resumeLoop: (id) => {
              const resumed = getStore().resume(id);
              if (!resumed) return false;
              try {
                getTriggerSystem().add(resumed);
                if (resumed.trigger.type === "dynamic") onDynamicLoopActivated?.(resumed);
              } catch (error) {
                try { getTriggerSystem().remove(id); } catch { /* rollback continues */ }
                try { getStore().pause(id); } catch { /* preserve the original error */ }
                throw error;
              }
              refreshWidget();
              return true;
            },
            deleteLoop: (id) => {
              const entry = getStore().get(id);
              if (!entry) return false;
              const deleted = getStore().delete(id);
              if (!deleted) return false;
              try { getTriggerSystem().remove(id); } catch { /* deleted state remains authoritative */ }
              onLoopStopped?.(id);
              refreshWidget();
              return true;
            },
            stopMonitor: async (id) => {
              onMonitorStopping?.(id);
              const stopped = await getMonitorManager().stop(id);
              refreshWidget();
              return stopped;
            },
          }, closeCurrent);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The monitor dashboard could not be opened.";
        ctx.ui.notify(message, "error");
      } finally {
        if (closeActiveDashboard === commandClose) closeActiveDashboard = undefined;
      }
    },
  });
}
