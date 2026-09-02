import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCoordinator, type ReducerEffect, type ReducerEvent, type ReducerHandler } from "../coordinator.js";
import { formatTrigger } from "../loop-format.js";
import { type NotificationReducerEvent, type NotificationReducerState, type ReducerNotification, reduceNotificationState } from "../notification-reducer.js";
import type { DynamicLoopState, MonitorOutcome, Trigger } from "../types.js";
import type { LoopExpiredPayload } from "./loop-events.js";

export interface LoopFireEvent { loopId: string; prompt: string; trigger: Trigger | string; timestamp: number; readOnly?: boolean; recurring?: boolean; persistent?: boolean; dynamic?: DynamicLoopState; fireLimitReached?: boolean; monitorOutcome?: MonitorOutcome; sessionGeneration?: number }
export interface PendingNotification extends LoopFireEvent { key: string; message: string }
export interface MonitorStartedEvent { monitorId: string; command: string; description?: string; timestamp: number; sessionGeneration?: number }
export interface NotificationRuntimeOptions { pi: ExtensionAPI; getHasPendingMessages: () => boolean; debug?: (...args: unknown[]) => void }
export interface NotificationRuntime {
  syncRuntimeState(options?: { agentRunning?: boolean; hasPendingMessages?: boolean }): void;
  queueOrDeliverNotification(data: LoopFireEvent): Promise<void>;
  queueOrDeliverLoopExpired(data: LoopExpiredPayload & { sessionGeneration?: number }): Promise<void>;
  queueOrDeliverMonitorStarted(data: MonitorStartedEvent): Promise<void>;
  discardMonitorStarted(monitorId: string): void;
  flushPendingNotifications(options?: { ignorePendingMessages?: boolean }): Promise<void>;
  clear(reason: "session_shutdown" | "session_switch"): void;
}

export function createNotificationRuntime({ pi, getHasPendingMessages, debug }: NotificationRuntimeOptions): NotificationRuntime {
  let state: NotificationReducerState = { notificationsByKey: {}, agentRunning: false, hasPendingMessages: false };
  let flushPromise: Promise<void> | undefined;
  let sessionGeneration = 0;
  const reducer: ReducerHandler = (incoming: ReducerEvent) => { const result = reduceNotificationState(state, incoming as NotificationReducerEvent); state = result.state; return result.effects; };
  const coordinator = createCoordinator<{ kind: "delivery"; delivered: boolean }>({ reducers: [reducer], effectHandlers: {
    REQUEST_NOTIFICATION_FLUSH: async () => undefined,
    DELIVER_NOTIFICATION: async (effect: ReducerEffect) => ({ kind: "delivery", delivered: deliver((effect.payload as { notification: ReducerNotification }).notification) }),
  } });
  function apply(event: NotificationReducerEvent) { const result = reduceNotificationState(state, event); state = result.state; return result; }
  function syncRuntimeState(options?: { agentRunning?: boolean; hasPendingMessages?: boolean }) {
    apply({ type: "NOTIFICATION_RUNTIME_UPDATED", at: Date.now(), source: "system", entityType: "notification", payload: { agentRunning: options?.agentRunning ?? state.agentRunning, hasPendingMessages: options?.hasPendingMessages ?? getHasPendingMessages() } });
  }
  function fireMessage(data: LoopFireEvent): string {
    const id = data.loopId || "?";
    const constraint = data.readOnly ? "\n\nREAD-ONLY MODE — use only read tools. Do not write files, execute shell commands, or make destructive changes." : "";
    if (data.dynamic || (typeof data.trigger !== "string" && data.trigger.type === "dynamic")) {
      const dynamic = data.dynamic;
      const lines = [`[pi-loop-monitor] Loop #${id} fired (dynamic).${constraint}`, `Goal: ${dynamic?.goal ?? data.prompt}`, `Iteration: ${dynamic?.iteration ?? 0}`];
      if (dynamic?.state) lines.push(`State: ${dynamic.state}`);
      if (dynamic?.metrics) lines.push(`Metrics: ${dynamic.metrics}`);
      if (dynamic?.doneCriteria) lines.push(`Done criteria: ${dynamic.doneCriteria}`);
      lines.push(data.fireLimitReached
        ? "This was the final bounded wake and the loop has been retired. Do not call LoopUpdate for it."
        : "Before ending this turn, call LoopUpdate exactly once: completed only when the goal is done, continue while work remains, or paused only for a genuine blocker.");
      return lines.join("\n");
    }
    const lifecycle = (data.persistent ?? data.recurring)
      ? `Loop lifecycle: Loop #${id} remains active. Do not delete or pause it merely because this run found no changes.`
      : `Loop lifecycle: Loop #${id} is one-shot and cleanup is automatic.`;
    return [`[pi-loop-monitor] Loop #${id} fired (${formatTrigger(data.trigger, "notification")}).${constraint}`, data.prompt, lifecycle].join("\n");
  }
  function pending(data: LoopFireEvent): PendingNotification { return { ...data, sessionGeneration: data.sessionGeneration ?? sessionGeneration, key: data.recurring ? `loop:${data.loopId}` : `loop:${data.loopId}:${data.timestamp}`, message: fireMessage(data) }; }
  function expired(data: LoopExpiredPayload & { sessionGeneration?: number }): PendingNotification {
    const stale = data.reason === "resume_event_stale";
    return { sessionGeneration: data.sessionGeneration ?? sessionGeneration, loopId: data.loopId, prompt: data.prompt, trigger: data.trigger, timestamp: data.expiredAt, recurring: data.recurring, key: `loop:${data.loopId}:expired:${data.expiresAt}`, message: [stale ? `[pi-loop-monitor] Loop #${data.loopId} retired during session recovery.` : `[pi-loop-monitor] Loop #${data.loopId} expired.`, data.prompt, stale ? "Event and hybrid subscriptions do not resume across sessions." : `Expiry boundary: ${new Date(data.expiresAt).toISOString()}`, "Recreate it explicitly if it is still required."].join("\n") };
  }
  function monitorStarted(data: MonitorStartedEvent): PendingNotification { const label = data.description ?? data.command.slice(0, 80); return { sessionGeneration: data.sessionGeneration ?? sessionGeneration, loopId: `monitor:${data.monitorId}`, prompt: label, trigger: { type: "event", source: "monitor:started" }, timestamp: data.timestamp, key: `monitor:${data.monitorId}:started`, message: `[pi-loop-monitor] Monitor #${data.monitorId} started: ${label}\nUse MonitorList to inspect its status or buffered output.` }; }
  function deliver(notification: ReducerNotification): boolean {
    if ((notification.sessionGeneration ?? sessionGeneration) !== sessionGeneration) return false;
    syncRuntimeState({ agentRunning: true });
    pi.sendMessage({ customType: "pi-loop-monitor", content: notification.message, display: false, details: { loopId: notification.loopId, trigger: notification.trigger, recurring: notification.recurring, persistent: notification.persistent, readOnly: notification.readOnly, dynamic: notification.dynamic, timestamp: notification.timestamp } }, { deliverAs: "steer", triggerTurn: true });
    return true;
  }
  async function flushPendingNotifications(options?: { ignorePendingMessages?: boolean }): Promise<void> {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => { syncRuntimeState({ hasPendingMessages: getHasPendingMessages() }); while (true) { const results = await coordinator.dispatch({ type: "NOTIFICATION_FLUSH_REQUESTED", at: Date.now(), source: "system", entityType: "notification", payload: { ignorePendingMessages: options?.ignorePendingMessages } }); const result = results.find((item) => item.kind === "delivery"); if (!result || result.delivered) return; } })().finally(() => { flushPromise = undefined; });
    return flushPromise;
  }
  async function enqueue(notification: PendingNotification, source: "system" | "monitor" = "system") { apply({ type: "NOTIFICATION_QUEUED", at: notification.timestamp, source, entityType: "notification", entityId: notification.key, payload: { notification } }); await flushPendingNotifications(); }
  async function queueOrDeliverNotification(data: LoopFireEvent) { if (data.sessionGeneration !== undefined && data.sessionGeneration !== sessionGeneration) { debug?.("dropping stale loop wake"); return; } await enqueue(pending(data)); }
  async function queueOrDeliverLoopExpired(data: LoopExpiredPayload & { sessionGeneration?: number }) { if (data.sessionGeneration !== undefined && data.sessionGeneration !== sessionGeneration) return; await enqueue(expired(data)); }
  async function queueOrDeliverMonitorStarted(data: MonitorStartedEvent) { if (data.sessionGeneration !== undefined && data.sessionGeneration !== sessionGeneration) return; await enqueue(monitorStarted(data), "monitor"); }
  function discardMonitorStarted(monitorId: string) { apply({ type: "NOTIFICATION_DROPPED", at: Date.now(), source: "monitor", entityType: "notification", entityId: `monitor:${monitorId}:started`, payload: { key: `monitor:${monitorId}:started`, reason: "superseded" } }); }
  function clear(reason: "session_shutdown" | "session_switch") { sessionGeneration++; syncRuntimeState({ agentRunning: false, hasPendingMessages: false }); apply({ type: "NOTIFICATION_CLEARED", at: Date.now(), source: "session", entityType: "notification", payload: { reason } }); }
  return { syncRuntimeState, queueOrDeliverNotification, queueOrDeliverLoopExpired, queueOrDeliverMonitorStarted, discardMonitorStarted, flushPendingNotifications, clear };
}
