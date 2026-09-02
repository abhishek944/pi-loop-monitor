import type { LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopExpirySource } from "../types.js";
export interface LoopExpiredPayload {
  loopId: string;
  prompt: string;
  trigger: LoopEntry["trigger"];
  recurring: boolean;
  createdAt: number;
  expiresAt: number;
  expiredAt: number;
  disposition: LoopExpiryDisposition;
  source: LoopExpirySource;
  reason: LoopExpiryReason;
}
export function buildLoopExpiredPayload(entry: LoopEntry, disposition: LoopExpiryDisposition, source: LoopExpirySource, reason: LoopExpiryReason, expiredAt: number): LoopExpiredPayload {
  return { loopId: entry.id, prompt: entry.prompt, trigger: entry.trigger, recurring: entry.recurring, createdAt: entry.createdAt, expiresAt: entry.expiresAt, expiredAt, disposition, source, reason };
}
