import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const execute = promisify(execFile);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
async function app(args: string[], ctx: ExtensionContext): Promise<Record<string, unknown>> {
  // Match panel files to the normal desktop instance, not an inherited test fixture.
  const env = { ...process.env };
  delete env.HERDR_APP_HOME;
  const { stdout } = await execute("herdr-app", args, { cwd: ctx.cwd, env, signal: ctx.signal, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const result = object(JSON.parse(stdout));
  if (!result || result.error) throw new Error(String(result?.error ?? "Invalid Herdr response."));
  return result;
}

/** Public Core document read only. One connection per deliberate opener, no service. */
async function readAppDocument(ctx: ExtensionContext): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("hc", ["connect"], { cwd: ctx.cwd, signal: ctx.signal, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => finish(new Error("Core pane inventory timed out.")), 10_000);
    let settled = false;
    function finish(error?: Error, value?: Record<string, unknown>) {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve(value!);
    }
    child.on("error", (error) => finish(error));
    child.on("close", () => { if (!settled) finish(new Error("Core closed before returning its pane inventory.")); });
    child.stdin.on("error", (error) => finish(error));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { finish(new Error("Core pane inventory is too large.")); return; }
      const end = output.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = object(JSON.parse(output.slice(0, end)));
        const value = object(object(reply?.result)?.value);
        if (reply?.id !== "activity-pane-read" || !value || reply.error) throw new Error("Core returned no usable pane inventory.");
        finish(undefined, value);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "activity-pane-read", method: "doc.get", params: { name: "herdr-app" } })}\n`);
  });
}

function blocks(value: unknown): Record<string, unknown>[] {
  const node = object(value);
  if (!node) return [];
  return [...(node.type === "block" ? [node] : []), ...(Array.isArray(node.children) ? node.children.flatMap(blocks) : [])];
}

/** Show beside this terminal, or hide only its same-session activity mod panes. */
export async function setHerdrActivityPaneVisible(ctx: ExtensionContext, visible: boolean, snapshot: string | undefined): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal || !/^t[0-9a-z]+$/.test(terminal)) throw new Error("Open this Pi session in local Herdr Core first.");
  const inventory = await app(["ls"], ctx);
  const document = await readAppDocument(ctx);
  let paneBlocks: Record<string, unknown>[] | undefined;
  for (const rawSpace of Array.isArray(document.spaces) ? document.spaces : []) {
    const space = object(rawSpace);
    for (const rawTab of Array.isArray(space?.tabs) ? space.tabs : []) {
      const tab = object(rawTab);
      const candidates = blocks(tab?.root);
      if (!candidates.some((block) => object(block.content)?.terminal === terminal)) continue;
      const liveSpace = (Array.isArray(inventory.spaces) ? inventory.spaces : []).map(object).find((entry) => entry?.id === space?.id);
      if (!liveSpace || liveSpace.machine) throw new Error("Native activity supports a visible local Herdr tab only.");
      const liveTab = (Array.isArray(liveSpace.tabs) ? liveSpace.tabs : []).map(object).find((entry) => entry?.id === tab?.id);
      const source = (Array.isArray(liveTab?.terminals) ? liveTab.terminals : []).map(object).find((entry) => entry?.terminal === terminal);
      if (!source || !candidates.some((block) => block.id === source.pane && object(block.content)?.terminal === terminal)) {
        throw new Error("The source terminal pane changed. Retry from this Pi session.");
      }
      paneBlocks = candidates;
    }
  }
  if (!paneBlocks) throw new Error("This Pi terminal has no pane in the running Herdr app.");
  if (!visible) {
    for (const block of paneBlocks) {
      const content = object(block.content); const binding = object(content?.props);
      if (typeof block.id !== "string" || content?.terminal != null || content?.mod !== "pi-loop-monitor" || binding?.sessionId !== sessionId || binding.terminal !== terminal) continue;
      await app(["do", "pane.close", JSON.stringify({ pane: block.id })], ctx);
    }
    return;
  }
  if (!snapshot || !isAbsolute(snapshot)) throw new Error("Activity display is unavailable. Restart/resume this Pi session and try again.");
  const projection = object(JSON.parse(await readFile(snapshot, "utf8")));
  if (projection?.source !== "pi-loop-monitor" || projection.sessionId !== sessionId || projection.terminal !== terminal || !projection.live || typeof projection.runtimeId !== "string") throw new Error("The activity projection does not match this live Pi runtime.");
  const tasks = paneBlocks.filter((block) => {
    const content = object(block.content); const binding = object(content?.props);
    return content?.mod === "pi-tasks" && binding?.sessionId === sessionId && binding.terminal === terminal;
  });
  const anchor = tasks[0] ?? paneBlocks.find((block) => object(block.content)?.terminal === terminal)!;
  const existing = paneBlocks.filter((block) => object(block.content)?.mod === "pi-loop-monitor");
  if (existing.length) {
    const binding = object(object(existing[0]?.content)?.props);
    if (existing.length !== 1 || binding?.sessionId !== sessionId || binding.runtimeId !== projection.runtimeId || binding.terminal !== terminal) throw new Error("This tab already has an activity view from another runtime. Close only that view, then reopen it from the intended Pi session.");
    await app(["do", "pane.focus", JSON.stringify({ pane: existing[0]!.id })], ctx);
    return;
  }
  const home = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-app");
  const status = await app(["status"], ctx);
  if (typeof status.layout !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(status.layout)) throw new Error("No usable Herdr layout.");
  const layout: unknown = JSON.parse(await readFile(join(home, "layouts", `${status.layout}.json`), "utf8"));
  const frames = blocks(layout).filter((block) => object(block.content)?.tab === "active").map((block) => object(object(block.content)?.pane));
  if (!frames.length || frames.some((frame) => {
    const header = object(frame?.header);
    return frame?.gap !== 8 || object(header?.content)?.mod !== "pi-tasks-pane-header" || header?.height !== 32 || (header.position ?? "top") !== "top" || header.reveal === "hover";
  })) throw new Error("Activity needs the personal Tasks layout with an always-visible 32px header and 8px native pane gap. Your layout was preserved; adjust that personal layout first.");
  const header = object(JSON.parse(await readFile(join(home, "mods", "pi-tasks-pane-header", "mod.json"), "utf8")));
  if (header?.pi_activity_header !== 1) throw new Error("Install the activity-aware personal Tasks header before opening this view. The existing header was preserved.");
  const directory = join(home, "mods", "pi-loop-monitor");
  await mkdir(directory, { recursive: true });
  for (const name of ["main.js", "mod.json", "spinner.svg", "README.md"]) {
    const contents = await readFile(new URL(`../herdr/pi-loop-monitor/${name}`, import.meta.url));
    try { await writeFile(join(directory, name), contents, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  await app(["do", "pane.split", JSON.stringify({ pane: anchor.id, direction: tasks.length ? "down" : "right", mod: "pi-loop-monitor", props: { sessionId, snapshot, runtimeId: projection.runtimeId, terminal } })], ctx);
}
