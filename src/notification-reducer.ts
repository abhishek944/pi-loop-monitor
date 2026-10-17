import type { DynamicLoopState, MonitorOutcome } from "./types.js";

type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export type NotificationDeliveryGroup = "monitor-state" | "monitor-terminal" | "monitor-started" | "loop-expiry";

export interface ReducerNotification {
  key: string;
  loopId: string;
  message: string;
  timestamp: number;
  trigger: unknown;
  recurring?: boolean;
  persistent?: boolean;
  readOnly?: boolean;
  dynamic?: DynamicLoopState;
  monitorOutcome?: MonitorOutcome;
  fireLimitReached?: boolean;
  sessionGeneration?: number;
  deliveryGroup?: NotificationDeliveryGroup;
  monitorId?: string;
  revision?: number;
  sourceEpoch?: number;
  changedAt?: number;
}

export interface NotificationReducerState {
  notificationsByKey: Record<string, ReducerNotification>;
  agentRunning: boolean;
  hasPendingMessages: boolean;
}

export type NotificationReducerEvent =
  | {
    type: "NOTIFICATION_QUEUED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { notification: ReducerNotification };
  }
  | {
    type: "NOTIFICATION_DROPPED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
      key: string;
      reason: "session_switch" | "session_shutdown" | "superseded";
    };
  }
  | {
    type: "NOTIFICATION_CLEARED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { reason: "session_switch" | "session_shutdown" };
  }
  | {
    type: "NOTIFICATION_FLUSH_REQUESTED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { ignorePendingMessages?: boolean };
  }
  | {
    type: "NOTIFICATION_RUNTIME_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { agentRunning: boolean; hasPendingMessages: boolean };
  };

export type NotificationReducerEffect =
  | {
    type: "REQUEST_NOTIFICATION_FLUSH";
    payload: Record<string, never>;
  }
  | {
    type: "DELIVER_NOTIFICATION";
    entityType: "notification";
    entityId: string;
    payload: { notification: ReducerNotification };
  }
  | {
    type: "DELIVER_NOTIFICATION_DIGEST";
    entityType: "notification";
    entityId: string;
    payload: { notifications: ReducerNotification[] };
  };

export interface NotificationReduceResult {
  state: NotificationReducerState;
  effects: NotificationReducerEffect[];
}

function cloneState(state: NotificationReducerState): NotificationReducerState {
  return {
    notificationsByKey: { ...state.notificationsByKey },
    agentRunning: state.agentRunning,
    hasPendingMessages: state.hasPendingMessages,
  };
}

function canShareDigest(candidate: ReducerNotification, anchor: ReducerNotification): boolean {
  return candidate.deliveryGroup === "monitor-state"
    && anchor.deliveryGroup === "monitor-state"
    && candidate.readOnly !== true
    && anchor.readOnly !== true
    && !candidate.dynamic
    && !anchor.dynamic
    && candidate.sessionGeneration === anchor.sessionGeneration;
}

export function reduceNotificationState(
  state: NotificationReducerState,
  event: NotificationReducerEvent,
): NotificationReduceResult {
  if (event.type === "NOTIFICATION_QUEUED") {
    const notification = event.payload.notification;
    const existing = state.notificationsByKey[notification.key];
    // A retry or late update must never roll a mailbox back to an older revision.
    if (existing && notification.revision !== undefined && (existing.revision ?? 0) > notification.revision) {
      return { state, effects: [] };
    }
    const next = cloneState(state);
    next.notificationsByKey[notification.key] = notification;
    return {
      state: next,
      effects: [{ type: "REQUEST_NOTIFICATION_FLUSH", payload: {} }],
    };
  }

  if (event.type === "NOTIFICATION_DROPPED") {
    const next = cloneState(state);
    delete next.notificationsByKey[event.payload.key];
    return { state: next, effects: [] };
  }

  if (event.type === "NOTIFICATION_CLEARED") {
    return {
      state: {
        ...state,
        notificationsByKey: {},
      },
      effects: [],
    };
  }

  if (event.type === "NOTIFICATION_RUNTIME_UPDATED") {
    return {
      state: {
        ...state,
        agentRunning: event.payload.agentRunning,
        hasPendingMessages: event.payload.hasPendingMessages,
      },
      effects: [],
    };
  }

  if (event.type === "NOTIFICATION_FLUSH_REQUESTED") {
    if (state.agentRunning) return { state, effects: [] };
    if (!event.payload.ignorePendingMessages && state.hasPendingMessages) {
      return { state, effects: [] };
    }

    const queued = Object.values(state.notificationsByKey)
      .sort((left, right) => left.timestamp - right.timestamp);
    const nextNotification = queued[0];
    if (!nextNotification) return { state, effects: [] };

    // Routine monitor state is delivered as one current digest. Read-only,
    // dynamic, and other loop notices keep their own delivery contracts.
    const group = nextNotification.deliveryGroup === "monitor-state"
      ? queued.filter((notification) => canShareDigest(notification, nextNotification))
      : [nextNotification];
    const next = cloneState(state);
    for (const notification of group) delete next.notificationsByKey[notification.key];
    if (group.length > 1) {
      return {
        state: next,
        effects: [{
          type: "DELIVER_NOTIFICATION_DIGEST",
          entityType: "notification",
          entityId: nextNotification.key,
          payload: { notifications: group },
        }],
      };
    }

    return {
      state: next,
      effects: [{
        type: "DELIVER_NOTIFICATION",
        entityType: "notification",
        entityId: nextNotification.key,
        payload: { notification: nextNotification },
      }],
    };
  }

  return { state, effects: [] };
}
