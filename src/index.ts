/** Private pi-loop-monitor extension for persistent loop wakes and background process monitoring. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLoopCommand } from "./commands/loop-command.js";
import { registerMonitorsCommand } from "./commands/monitors-command.js";
import { atMaxFires } from "./loop-reducer.js";
import { MonitorManager } from "./monitor-manager.js";
import { buildLoopExpiredPayload } from "./runtime/loop-events.js";
import { createMonitorOnDoneRuntime } from "./runtime/monitor-ondone-runtime.js";
import { createNotificationRuntime, type LoopFireEvent } from "./runtime/notification-runtime.js";
import { resolveLoopStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { isStaleExtensionContextError } from "./runtime/stale-context.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { registerMonitorTools } from "./tools/monitor-tools.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopExpirySource, LoopFireOrigin, MonitorEntry } from "./types.js";
import { LoopWidget } from "./ui/widget.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) { if (DEBUG) console.error("[pi-loop-monitor]", ...args); }

export default function (pi: ExtensionAPI) {
  const runtimeId = randomUUID();
  const runtimeProbeEvent = `pi-loop-monitor:runtime-probe:${runtimeId}`;
  const piLoopEnv = process.env.PI_LOOP;
  let loopScope = (process.env.PI_LOOP_SCOPE as "memory" | "session" | "project" | undefined) ?? "session";
  let sessionGeneration = 0;
  let latestCtx: ExtensionContext | undefined;
  let store = new LoopStore(resolveLoopStorePath({ piLoopEnv, loopScope }));
  const memoryStores = new Map<string, LoopStore>();
  const monitorManager = new MonitorManager(pi);
  const widget = new LoopWidget(store, monitorManager);
  monitorManager.setOnChange(() => widget.update());

  function isCurrentExtensionContext(): boolean {
    try { pi.events.emit(runtimeProbeEvent, { runtimeId, sessionGeneration }); return true; }
    catch (error) { if (!isStaleExtensionContextError(error)) throw error; debug("dropping stale runtime callback"); return false; }
  }
  function emitExpired(entry: LoopEntry, disposition: LoopExpiryDisposition, source: LoopExpirySource, reason: LoopExpiryReason, generation = sessionGeneration) {
    if (generation !== sessionGeneration || !isCurrentExtensionContext()) return;
    triggerSystem.remove(entry.id);
    const payload = buildLoopExpiredPayload(entry, disposition, source, reason, Date.now());
    try { pi.events.emit("loops:expired", payload); } catch (error) { debug("loops:expired listener failed", error); }
    void notificationRuntime.queueOrDeliverLoopExpired({ ...payload, sessionGeneration: generation }).catch((error) => debug("expiry notification failed", error));
  }
  function createScheduler(loopStore: LoopStore) { return new CronScheduler(loopStore, (entry, origin) => onLoopFire(entry, undefined, origin), (entry, disposition) => emitExpired(entry, disposition, "scheduler", "expires_at"), isCurrentExtensionContext); }
  let scheduler = createScheduler(store);
  let triggerSystem = new TriggerSystem(pi, scheduler, store, (entry, origin) => onLoopFire(entry, undefined, origin));
  const notificationRuntime = createNotificationRuntime({ pi, getHasPendingMessages: () => latestCtx?.hasPendingMessages() ?? false, debug });
  const monitorOnDoneRuntime = createMonitorOnDoneRuntime({ monitorManager, getLoop: (id) => store.get(id), deleteLoop: (id) => { store.delete(id); }, onLoopFire, isContextCurrent: isCurrentExtensionContext, debug });

  registerMonitorsCommand({ pi, getStore: () => store, getMonitorManager: () => monitorManager, getTriggerSystem: () => triggerSystem, updateWidget: () => widget.update(), onDynamicLoopActivated: onLoopFire });

  function emitLoopFire(entry: LoopEntry, monitor?: MonitorEntry) {
    pi.events.emit("loop:fire", { loopId: entry.id, prompt: entry.prompt, trigger: entry.trigger, timestamp: Date.now(), readOnly: entry.readOnly, recurring: entry.recurring, persistent: entry.recurring, dynamic: entry.dynamic, fireLimitReached: atMaxFires(entry), sessionGeneration, monitorOutcome: monitor ? { monitorId: monitor.id, status: monitor.status, exitCode: monitor.exitCode, stopReason: monitor.stopReason, outputLines: monitor.outputLines } : undefined });
  }
  function onLoopFire(entry: LoopEntry, monitor?: MonitorEntry, origin: LoopFireOrigin = monitor ? "monitor" : "dynamic") {
    if (!isCurrentExtensionContext()) return;
    const current = store.get(entry.id);
    if (current?.status !== "active") { triggerSystem.remove(entry.id); return; }
    if (atMaxFires(current)) { triggerSystem.remove(current.id); store.delete(current.id); widget.update(); return; }
    const fired = store.fire(current.id, origin);
    if (!fired) return;
    const firedAt = Date.now();
    const updated = fired.trigger.type === "dynamic" ? store.updateDynamic(fired.id, { dynamic: { awaitingUpdate: true, nextWakeAt: undefined, lastUpdatedAt: firedAt } }) ?? fired : fired;
    const delivered = { ...updated, prompt: entry.prompt };
    if (atMaxFires(delivered)) { triggerSystem.remove(delivered.id); store.delete(delivered.id); widget.update(); }
    emitLoopFire(delivered, monitor);
  }

  registerSessionRuntimeHooks({
    pi, getLoopScope: () => loopScope, getPiLoopEnv: () => piLoopEnv, getSessionGeneration: () => sessionGeneration, advanceSessionGeneration: () => ++sessionGeneration,
    recreateSessionStore: (sessionId) => { const path = resolveLoopStorePath({ piLoopEnv, loopScope }, sessionId); store = path ? new LoopStore(path) : memoryStores.get(sessionId) ?? new LoopStore(); if (!path) memoryStores.set(sessionId, store); widget.setStore(store); scheduler = createScheduler(store); triggerSystem = new TriggerSystem(pi, scheduler, store, (entry, origin) => onLoopFire(entry, undefined, origin)); },
    clearAllLoops: () => { store.clearAll(); }, getStore: () => store, getScheduler: () => scheduler, getTriggerSystem: () => triggerSystem,
    setLatestCtx: (ctx) => { latestCtx = ctx; }, setSessionId: () => {}, widget, notificationRuntime,
    flushPendingNotifications: notificationRuntime.flushPendingNotifications, shutdownMonitors: () => monitorManager.shutdown(), isContextCurrent: isCurrentExtensionContext,
    emitLoopExpired: (entry, disposition, reason, generation) => emitExpired(entry, disposition, "session_recovery", reason, generation),
  });

  pi.events.on("loop:fire", async (event: unknown) => notificationRuntime.queueOrDeliverNotification(event as LoopFireEvent));
  pi.events.on("monitor:started", async (event: unknown) => { const data = event as { monitorId?: string; command?: string; description?: string; timestamp?: number }; if (data.monitorId && data.command) await notificationRuntime.queueOrDeliverMonitorStarted({ monitorId: data.monitorId, command: data.command, description: data.description, timestamp: data.timestamp ?? Date.now(), sessionGeneration }); });
  pi.events.on("monitor:finished", (event: unknown) => { const id = (event as { monitorId?: string }).monitorId; if (id) notificationRuntime.discardMonitorStarted(id); });

  registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => triggerSystem, getScheduler: () => scheduler, getMonitorManager: () => monitorManager, updateWidget: () => widget.update(), onDynamicLoopActivated: onLoopFire });
  registerMonitorTools({ pi, getStore: () => store, getMonitorManager: () => monitorManager, updateWidget: () => widget.update(), handleMonitorDoneLoop: (doneLoop, monitorId) => monitorOnDoneRuntime.register(doneLoop, monitorId) });
  registerLoopCommand({ pi, getStore: () => store, getTriggerSystem: () => triggerSystem, updateWidget: () => widget.update(), onDynamicLoopActivated: onLoopFire });
}
