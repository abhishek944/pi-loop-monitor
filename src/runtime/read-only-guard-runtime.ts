import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopFireEvent } from "./notification-runtime.js";

const PI_ASK_GUARD_ACQUIRE_EVENT = "pi-ask:guard:acquire";
const PI_ASK_GUARD_RELEASE_EVENT = "pi-ask:guard:release";
const PI_ASK_GUARD_PROBE_EVENT = "pi-ask:guard:probe";

const READ_ONLY_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
] as const;

const OWN_TOOL_NAMES = ["LoopList", "MonitorList"] as const;
const OWN_EXTENSION_ENTRY_STEM = fileURLToPath(new URL("../index", import.meta.url));

function withoutTypeScriptOrJavaScriptExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]s)$/, "");
}

interface GuardAcquireRequest {
  ownerId: string;
  allowedTools: Array<string | {
    name: string;
    equals?: Record<string, string>;
    sourceInfo?: { source: string; path: string };
  }>;
  context: string;
  startsRun: true;
  response?: {
    status: "active" | "rejected";
    ownerId?: string;
    acquisitionToken?: string;
    reason?: string;
  };
}

interface GuardReleaseRequest {
  ownerId: string;
  acquisitionToken: string;
  released?: boolean;
}

export interface ReadOnlyGuardAcquisition {
  ownerId?: string;
  acquisitionToken?: string;
  reason?: string;
}

export function getReadOnlyWakeGuardStatus(pi: ExtensionAPI): { available: boolean; active: boolean } {
  const request: { available?: boolean; protocolVersion?: number; active?: boolean } = {};
  pi.events.emit(PI_ASK_GUARD_PROBE_EVENT, request);
  return {
    available: request.available === true && request.protocolVersion === 1,
    active: request.active === true,
  };
}

export function isReadOnlyWakeGuardAvailable(pi: ExtensionAPI): boolean {
  return getReadOnlyWakeGuardStatus(pi).available;
}

export function acquireReadOnlyWakeGuard(pi: ExtensionAPI, notification: LoopFireEvent & { key: string }): ReadOnlyGuardAcquisition {
  const ownerId = `pi-loop-monitor:${notification.key}`;
  const allowedTools: GuardAcquireRequest["allowedTools"] = [...READ_ONLY_TOOL_NAMES];
  const configuredTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const ownToolRule = (name: string, equals?: Record<string, string>) => {
    const sourceInfo = configuredTools.get(name)?.sourceInfo;
    if (!sourceInfo || withoutTypeScriptOrJavaScriptExtension(resolve(sourceInfo.path)) !== OWN_EXTENSION_ENTRY_STEM) {
      return { name, ...(equals ? { equals } : {}), sourceInfo: { source: "pi-loop-monitor", path: OWN_EXTENSION_ENTRY_STEM } };
    }
    return { name, ...(equals ? { equals } : {}), sourceInfo: { source: sourceInfo.source, path: sourceInfo.path } };
  };
  allowedTools.push(...OWN_TOOL_NAMES.map((name) => ownToolRule(name)));
  if (notification.dynamic || (typeof notification.trigger !== "string" && notification.trigger.type === "dynamic")) {
    allowedTools.push(ownToolRule("LoopUpdate", { id: notification.loopId }));
  }
  const request: GuardAcquireRequest = {
    ownerId,
    allowedTools,
    context: `[READ-ONLY LOOP #${notification.loopId}] Tool access is restricted for this wake. Do not attempt project changes or shell commands.`,
    startsRun: true,
  };
  pi.events.emit(PI_ASK_GUARD_ACQUIRE_EVENT, request);
  if (
    request.response?.status === "active"
    && request.response.ownerId === ownerId
    && request.response.acquisitionToken
  ) return { ownerId, acquisitionToken: request.response.acquisitionToken };
  return { reason: request.response?.reason ?? "pi-ask guard unavailable" };
}

export function releaseReadOnlyWakeGuard(pi: ExtensionAPI, ownerId: string, acquisitionToken: string): boolean {
  const request: GuardReleaseRequest = { ownerId, acquisitionToken };
  pi.events.emit(PI_ASK_GUARD_RELEASE_EVENT, request);
  return request.released === true;
}
