import { homedir } from "node:os";
import { join } from "node:path";
import { atMaxFires, type LoopReducerEffect, type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "./loop-reducer.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import type { DynamicLoopState, LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopFireOrigin, LoopPauseKind, LoopStoreData, Trigger } from "./types.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");
const MAX_LOOPS = 25;
export interface ExpiredLoopRecord { entry: LoopEntry; disposition: LoopExpiryDisposition; reason: LoopExpiryReason }

function normalizeLoopEntry(entry: LoopEntry): LoopEntry | undefined {
  const legacy = entry as LoopEntry & { workflow?: unknown; orchestration?: unknown };
  if (legacy.workflow || legacy.orchestration) return undefined;
  if (entry.status !== "active" && entry.status !== "paused") throw new Error("Malformed loop status");
  if (entry.pause && (entry.status !== "paused" || !["administrative", "controller_limit"].includes(entry.pause.kind))) {
    throw new Error("Malformed loop pause provenance");
  }
  return {
    id: entry.id,
    prompt: entry.prompt,
    trigger: entry.trigger,
    status: entry.status,
    recurring: entry.recurring,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    readOnly: entry.readOnly,
    maxFires: entry.maxFires,
    fireCount: entry.fireCount,
    pause: entry.pause,
    dynamic: entry.dynamic,
  };
}

export class LoopStore extends ReducerBackedStore<LoopEntry, LoopReducerState, LoopReducerEvent, LoopStoreData, LoopReducerEffect> {
  constructor(listIdOrPath?: string) {
    super({
      baseDir: LOOPS_DIR,
      reduce: reduceLoopState,
      toReducerState: (nextId, entries) => ({ nextId, loopsById: Object.fromEntries(entries.entries()) }),
      fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.loopsById)) }),
      serialize: (nextId, entries) => ({ nextId, loops: Array.from(entries.values()) }),
      deserialize: (data) => ({
        nextId: data.nextId,
        entries: new Map(data.loops.flatMap((entry) => {
          const normalized = normalizeLoopEntry(entry);
          return normalized ? [[entry.id, normalized]] : [];
        })),
      }),
    }, listIdOrPath);
  }

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; readOnly?: boolean; maxFires?: number; dynamic?: Partial<DynamicLoopState> }): LoopEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_LOOPS) throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      this.applyReducerEvent({ type: "LOOP_CREATED", at: Date.now(), source: "tool", entityType: "loop", payload: { prompt, trigger, ...opts } });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  pause(id: string, kind: LoopPauseKind = "administrative", reason?: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || entry.status === "paused") return entry;
      const boundedReason = reason?.trim().slice(0, 512);
      this.applyReducerEvent({ type: "LOOP_PAUSED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id, kind, ...(boundedReason ? { reason: boundedReason } : {}) } });
      return this.entries.get(id);
    });
  }

  resume(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || Date.now() >= entry.expiresAt || (entry.pause?.kind === "controller_limit" && atMaxFires(entry))) return undefined;
      this.applyReducerEvent({ type: "LOOP_RESUMED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id } });
      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate) {
        this.applyReducerEvent({ type: "LOOP_DYNAMIC_UPDATED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id, dynamic: { awaitingUpdate: false, lastUpdatedAt: Date.now() } } });
      }
      return this.entries.get(id);
    });
  }

  fire(id: string, origin: LoopFireOrigin = "scheduler"): LoopEntry | undefined {
    return this.withLock(() => {
      if (this.entries.get(id)?.status !== "active") return undefined;
      this.applyReducerEvent({ type: "LOOP_FIRED", at: Date.now(), source: "system", entityType: "loop", entityId: id, payload: { id, origin } });
      return this.entries.get(id);
    });
  }

  updateDynamic(id: string, fields: { prompt?: string; dynamic: Partial<DynamicLoopState> }): LoopEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({ type: "LOOP_DYNAMIC_UPDATED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id, ...fields } });
      return this.entries.get(id);
    });
  }

  continueDynamic(id: string, fields: { prompt?: string; dynamic: Partial<DynamicLoopState> }, expected?: { status: LoopEntry["status"]; iteration: number; updatedAt: number }): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || entry.trigger.type !== "dynamic" || !entry.dynamic) return undefined;
      if (expected && (entry.status !== expected.status || entry.dynamic.iteration !== expected.iteration || entry.updatedAt !== expected.updatedAt)) return undefined;
      const now = Date.now();
      if (now >= entry.expiresAt) return undefined;
      if (entry.status === "paused") this.applyReducerEvent({ type: "LOOP_RESUMED", at: now, source: "tool", entityType: "loop", entityId: id, payload: { id } });
      this.applyReducerEvent({ type: "LOOP_DYNAMIC_UPDATED", at: now, source: "tool", entityType: "loop", entityId: id, payload: { id, ...fields } });
      return this.entries.get(id);
    });
  }

  stopDynamic(id: string, status: "completed" | "paused", expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number }): boolean {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || entry.trigger.type !== "dynamic" || !entry.dynamic || entry.status !== expected.status || entry.dynamic.iteration !== expected.iteration || entry.updatedAt !== expected.updatedAt) return false;
      this.applyReducerEvent(status === "completed"
        ? { type: "LOOP_DELETED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id } }
        : { type: "LOOP_PAUSED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id, kind: "administrative" } });
      return true;
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.entries.has(id)) return false;
      this.applyReducerEvent({ type: "LOOP_DELETED", at: Date.now(), source: "tool", entityType: "loop", entityId: id, payload: { id } });
      return true;
    });
  }

  expireEntry(id: string, now = Date.now()): ExpiredLoopRecord | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || now < entry.expiresAt) return undefined;
      this.applyReducerEvent({ type: "LOOP_EXPIRED", at: now, source: "system", entityType: "loop", entityId: id, payload: { id, reason: "expires_at" } });
      return { entry, disposition: "deleted", reason: "expires_at" };
    });
  }

  expireEntries(now = Date.now()): ExpiredLoopRecord[] {
    const result: ExpiredLoopRecord[] = [];
    for (const id of this.list().map((entry) => entry.id)) { const record = this.expireEntry(id, now); if (record) result.push(record); }
    return result;
  }

  clearExpired(): number { return this.expireEntries().length; }
  expireEventLoopEntries(sessionStartedAt: number): ExpiredLoopRecord[] {
    return this.withLock(() => {
      const expired: ExpiredLoopRecord[] = [];
      for (const [id, entry] of [...this.entries]) {
        if (entry.status !== "active" || (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid") || entry.createdAt >= sessionStartedAt) continue;
        this.applyReducerEvent({ type: "LOOP_EXPIRED", at: sessionStartedAt, source: "session", entityType: "loop", entityId: id, payload: { id, reason: "resume_event_stale" } });
        expired.push({ entry, disposition: "deleted", reason: "resume_event_stale" });
      }
      return expired;
    });
  }
  expireEventLoops(sessionStartedAt: number): number { return this.expireEventLoopEntries(sessionStartedAt).length; }
  clearAll(): number {
    return this.withLock(() => {
      const entries = [...this.entries.values()];
      for (const entry of entries) this.applyReducerEvent({ type: "LOOP_DELETED", at: Date.now(), source: "system", entityType: "loop", entityId: entry.id, payload: { id: entry.id } });
      return entries.length;
    });
  }
}
