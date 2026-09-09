import { homedir } from "node:os";
import { join } from "node:path";

function resolveLoopsDir(): string {
  return join(homedir(), ".pi", "loops");
}

export function resolveLoopStorePath(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  return join(resolveLoopsDir(), `loops-${sessionId}.json`);
}
