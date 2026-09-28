export type LoopStatus = "active" | "paused";
export type LoopExpiryDisposition = "deleted" | "paused";
export type LoopExpiryReason = "expires_at" | "resume_event_stale";
export type LoopExpirySource = "scheduler" | "session_recovery";
export type LoopPauseKind = "administrative" | "controller_limit";

export interface LoopPauseRecord {
  kind: LoopPauseKind;
  at: number;
  reason?: string;
}

export type LoopFireOrigin = "scheduler" | "event" | "dynamic" | "monitor";
export interface CronTrigger { type: "cron"; schedule: string }
export interface EventTrigger { type: "event"; source: string; filter?: string }
export interface HybridTrigger { type: "hybrid"; cron: string; event: { source: string; filter?: string }; debounceMs: number }
export interface DynamicTrigger { type: "dynamic" }
export type Trigger = CronTrigger | EventTrigger | HybridTrigger | DynamicTrigger;

export interface DynamicLoopState {
  goal: string;
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  iteration: number;
  nextWakeAt?: number;
  awaitingUpdate?: boolean;
  lastUpdatedAt?: number;
}

export interface LoopEntry {
  id: string;
  prompt: string;
  trigger: Trigger;
  status: LoopStatus;
  recurring: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  readOnly?: boolean;
  maxFires?: number;
  fireCount?: number;
  pause?: LoopPauseRecord;
  dynamic?: DynamicLoopState;
}

export interface LoopStoreData { nextId: number; loops: LoopEntry[] }

export interface CommandReportedOutcome {
  status: string;
  message?: string;
}

export interface MonitorEntry {
  id: string;
  command: string;
  description?: string;
  timeout: number;
  status: "running" | "completed" | "error" | "stopped";
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  stopReason?: "manual" | "timeout";
  reportedOutcome?: CommandReportedOutcome;
  outputLines: number;
  outputBuffer: string[];
  lastActivityAt?: number;
  lastOutputAt?: number;
  outputRatePerMinute?: number;
  progress?: MonitorProgress;
}

export interface MonitorOutcome {
  monitorId: string;
  status: MonitorEntry["status"];
  exitCode?: number;
  stopReason?: MonitorEntry["stopReason"];
  reportedOutcome?: CommandReportedOutcome;
  outputLines: number;
}

export interface MonitorProgress {
  current?: number;
  total?: number;
  message?: string;
  source: "jsonl" | "agent";
  updatedAt: number;
}

export interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
  completionCallbacks: Array<(monitor: MonitorEntry) => void>;
  terminalCallbacks: Array<(monitor: MonitorEntry) => void>;
  terminalReady: boolean;
  lastActivityAt: number;
  lastActivityMonotonic: number;
  lastOutputEventAt: number;
  lastProgressChangeAt: number;
  progressChangeTimer?: ReturnType<typeof setTimeout>;
  pendingOutputLines: number;
  latestOutputLine?: string;
  outputBuckets: Array<{ second: number; count: number }>;
  stdoutDecoder: import("node:string_decoder").StringDecoder;
  stderrDecoder: import("node:string_decoder").StringDecoder;
  stdoutRemainder: string;
  stderrRemainder: string;
}
