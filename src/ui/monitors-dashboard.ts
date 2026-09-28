import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatTrigger } from "../loop-format.js";
import type { LoopEntry, MonitorEntry } from "../types.js";

export interface MonitorsDashboardActions {
  listLoops(): LoopEntry[];
  listMonitors(): MonitorEntry[];
  pauseLoop(id: string): boolean;
  resumeLoop(id: string): boolean;
  deleteLoop(id: string): boolean;
  stopMonitor(id: string): Promise<boolean>;
}

type DashboardItem =
  | { key: `monitor:${string}`; kind: "monitor"; monitor: MonitorEntry }
  | { key: `loop:${string}`; kind: "loop"; loop: LoopEntry };

type PendingAction = { action: "delete" | "stop"; key: string; expiresAt: number };

const OVERLAY_CHROME_LINES = 8;
const MIN_ACTION_WIDTH = 24;
const CONFIRMATION_MS = 4_000;

export class MonitorsDashboard implements Component, Focusable {
  focused = false;
  private selectedKey: string | undefined;
  private selectionVisible = false;
  private lastRenderWidth = 0;
  private lastItems: DashboardItem[] = [];
  private snapshotError: string | undefined;
  private scrollOffset = 0;
  private detailsVisible = true;
  private pendingAction: PendingAction | undefined;
  private message: string | undefined;
  private busy = false;
  private disposed = false;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private messageTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly actions: MonitorsDashboardActions,
    private readonly close: () => void,
  ) {
    this.refreshTimer = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, 1_000);
    this.refreshTimer.unref?.();
  }

  render(width: number): string[] {
    const dialogWidth = Math.max(1, width);
    this.lastRenderWidth = dialogWidth;
    const items = this.getItems();
    this.syncSelection(items);
    const dialogHeight = this.getDialogHeight();
    const monitors = items.filter((item) => item.kind === "monitor");
    const loops = items.filter((item) => item.kind === "loop");
    const running = monitors.filter((item) => item.monitor.status === "running").length;
    const active = loops.filter((item) => item.loop.status === "active").length;
    const summary = `${running}/${monitors.length} monitors running · ${active}/${loops.length} loops active · live`;

    if (dialogWidth < 4 || dialogHeight <= OVERLAY_CHROME_LINES) {
      return this.renderCompact(dialogWidth, dialogHeight, summary, items);
    }

    const innerWidth = dialogWidth - 2;
    const bodyHeight = dialogHeight - OVERLAY_CHROME_LINES;
    const detailBudget = Math.max(0, bodyHeight - 1);
    const detailLines = this.detailsVisible ? this.renderDetails(items, innerWidth).slice(0, detailBudget) : [];
    const maxListLines = Math.max(0, bodyHeight - detailLines.length);
    if (maxListLines > 0) this.keepSelectionVisible(items, maxListLines);
    const selectedLine = buildRenderedIndexes(items).get(this.selectedKey ?? "");
    this.selectionVisible = selectedLine !== undefined
      && selectedLine >= this.scrollOffset
      && selectedLine < this.scrollOffset + maxListLines;
    const body = this.renderList(items, innerWidth).slice(this.scrollOffset, this.scrollOffset + maxListLines);
    while (body.length < maxListLines) body.push("");
    const content = [...body, ...detailLines];

    return [
      this.borderLine(innerWidth, "top"),
      this.frameLine(this.theme.fg("accent", this.theme.bold("Monitors · loops and background work")), innerWidth),
      this.frameLine(this.theme.fg("dim", summary), innerWidth),
      this.ruleLine(innerWidth),
      ...content.map((line) => this.frameLine(line, innerWidth)),
      this.ruleLine(innerWidth),
      this.frameLine(this.renderMessage(innerWidth), innerWidth),
      this.frameLine(this.renderFooter(innerWidth), innerWidth),
      this.borderLine(innerWidth, "bottom"),
    ];
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    try {
      const configuredCancel = this.keybindings.matches(data, "tui.select.cancel");
      const configuredUp = this.keybindings.matches(data, "tui.select.up");
      const configuredDown = this.keybindings.matches(data, "tui.select.down");
      const configuredPageUp = this.keybindings.matches(data, "tui.select.pageUp");
      const configuredPageDown = this.keybindings.matches(data, "tui.select.pageDown");
      const configuredConfirm = this.keybindings.matches(data, "tui.select.confirm");
      if (configuredCancel) {
        this.close();
        return;
      }
      const items = this.getItems();
      this.syncSelection(items);
      const index = items.findIndex((item) => item.key === this.selectedKey);
      if (configuredUp) {
        this.select(items, Math.max(0, index - 1));
      } else if (configuredDown) {
        this.select(items, Math.min(items.length - 1, index + 1));
      } else if (configuredPageUp) {
        this.select(items, Math.max(0, index - 8));
      } else if (configuredPageDown) {
        this.select(items, Math.min(items.length - 1, index + 8));
      } else if (configuredConfirm) {
        this.detailsVisible = !this.detailsVisible;
        this.pendingAction = undefined;
      } else if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape) || matchesKey(data, "q")) {
        this.close();
        return;
      } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.select(items, Math.max(0, index - 1));
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.select(items, Math.min(items.length - 1, index + 1));
      } else if (matchesKey(data, Key.pageUp)) {
        this.select(items, Math.max(0, index - 8));
      } else if (matchesKey(data, Key.pageDown)) {
        this.select(items, Math.min(items.length - 1, index + 8));
      } else if (matchesKey(data, Key.home)) {
        this.select(items, 0);
      } else if (matchesKey(data, Key.end)) {
        this.select(items, items.length - 1);
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        this.detailsVisible = !this.detailsVisible;
        this.pendingAction = undefined;
      } else if (matchesKey(data, "p")) {
        this.toggleLoop(items[index]);
      } else if (matchesKey(data, "d")) {
        this.confirmDelete(items[index]);
      } else if (matchesKey(data, "s")) {
        void this.confirmStop(items[index]);
      } else if (matchesKey(data, "r")) {
        this.setMessage("Refreshed");
      }
      this.tui.requestRender();
    } catch (error) {
      this.pendingAction = undefined;
      this.setMessage(`Action failed: ${errorMessage(error)}`);
      this.tui.requestRender();
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.messageTimer) clearTimeout(this.messageTimer);
  }

  private getDialogHeight(): number {
    const terminalRows = this.tui.terminal.rows || process.stdout.rows || 30;
    return Math.max(1, Math.min(32, Math.floor(terminalRows * 0.78)));
  }

  private renderCompact(width: number, height: number, summary: string, items: DashboardItem[]): string[] {
    if (height <= 0) return [];
    const compactWidth = Math.max(1, width - 2);
    const status = this.renderMessage(compactWidth);
    const hints = this.renderFooter(compactWidth);
    if (width < 4 || height <= 2) {
      this.selectionVisible = false;
      const compact = height === 1 ? [status] : [status, hints];
      return compact.map((line) => truncateToWidth(line, width, ""));
    }

    const innerWidth = width - 2;
    const available = height - 2;
    const selected = items.find((item) => item.key === this.selectedKey);
    const selectedLine = selected
      ? selected.kind === "monitor" ? this.renderMonitorRow(selected, innerWidth) : this.renderLoopRow(selected, innerWidth)
      : this.theme.fg("muted", "No loops or monitors in this session.");
    this.selectionVisible = available >= 5 && selected !== undefined;
    let content: string[];
    if (available >= 5) content = [this.theme.fg("accent", this.theme.bold("Monitors")), this.theme.fg("dim", summary), selectedLine, status, hints];
    else if (available === 4) content = [this.theme.fg("accent", this.theme.bold("Monitors")), this.theme.fg("dim", summary), status, hints];
    else if (available === 3) content = [this.theme.fg("accent", this.theme.bold("Monitors")), status, hints];
    else if (available === 2) content = [status, hints];
    else content = [status];
    while (content.length < available) content.splice(Math.max(0, content.length - 2), 0, "");
    return [
      this.borderLine(innerWidth, "top"),
      ...content.slice(0, available).map((line) => this.frameLine(line, innerWidth)),
      this.borderLine(innerWidth, "bottom"),
    ];
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private getItems(): DashboardItem[] {
    try {
      const monitors = this.actions.listMonitors().map((monitor): DashboardItem => ({
        key: `monitor:${monitor.id}`,
        kind: "monitor",
        monitor,
      }));
      const loops = this.actions.listLoops().map((loop): DashboardItem => ({
        key: `loop:${loop.id}`,
        kind: "loop",
        loop,
      }));
      this.lastItems = [...monitors, ...loops];
      this.snapshotError = undefined;
      return this.lastItems;
    } catch (error) {
      this.snapshotError = `Refresh failed: ${errorMessage(error)}`;
      return this.lastItems;
    }
  }

  private syncSelection(items: DashboardItem[]): void {
    if (items.some((item) => item.key === this.selectedKey)) return;
    this.selectedKey = items[0]?.key;
    this.selectionVisible = false;
    this.scrollOffset = 0;
  }

  private select(items: DashboardItem[], index: number): void {
    if (items.length === 0) return;
    const nextKey = items[Math.max(0, Math.min(index, items.length - 1))]?.key;
    if (nextKey !== this.selectedKey) this.selectionVisible = false;
    this.selectedKey = nextKey;
    this.pendingAction = undefined;
  }

  private keepSelectionVisible(items: DashboardItem[], maxLines: number): void {
    const renderedIndexes = buildRenderedIndexes(items);
    const selectedLine = renderedIndexes.get(this.selectedKey ?? "") ?? 0;
    if (selectedLine < this.scrollOffset) this.scrollOffset = selectedLine;
    if (selectedLine >= this.scrollOffset + maxLines) this.scrollOffset = selectedLine - maxLines + 1;
    const totalLines = this.renderList(items, 10_000).length;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, totalLines - maxLines)));
  }

  private renderList(items: DashboardItem[], width: number): string[] {
    if (items.length === 0) {
      return ["", truncateToWidth(this.theme.fg("muted", "No loops or monitors in this session."), width)];
    }
    const lines: string[] = [];
    const monitors = items.filter((item): item is Extract<DashboardItem, { kind: "monitor" }> => item.kind === "monitor");
    const loops = items.filter((item): item is Extract<DashboardItem, { kind: "loop" }> => item.kind === "loop");
    if (monitors.length > 0) {
      lines.push(section(`MONITORS (${monitors.length})`, width, this.theme));
      for (const item of monitors) lines.push(this.renderMonitorRow(item, width));
    }
    if (loops.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(section(`LOOPS (${loops.length})`, width, this.theme));
      for (const item of loops) lines.push(this.renderLoopRow(item, width));
    }
    return lines;
  }

  private renderMonitorRow(item: Extract<DashboardItem, { kind: "monitor" }>, width: number): string {
    const monitor = item.monitor;
    const selected = item.key === this.selectedKey;
    const icon = monitor.status === "running" ? "●" : monitor.status === "completed" ? "✓" : "✕";
    const color = monitor.status === "running" ? "success" : monitor.status === "completed" ? "muted" : "error";
    const label = safeSingleLine(monitor.description ?? monitor.command) || "background command";
    const details = [
      formatProgress(monitor),
      monitor.reportedOutcome ? `reported ${safeSingleLine(monitor.reportedOutcome.status)}` : "",
      `${monitor.outputLines} lines`,
      formatDuration((monitor.completedAt ?? Date.now()) - monitor.startedAt),
    ].filter(Boolean).join(" · ");
    return row(selected, `${this.theme.fg(color, icon)} #${safeSingleLine(monitor.id)}  ${label}`, details, width, this.theme);
  }

  private renderLoopRow(item: Extract<DashboardItem, { kind: "loop" }>, width: number): string {
    const loop = item.loop;
    const selected = item.key === this.selectedKey;
    const icon = loop.status === "active" ? "●" : "○";
    const color = loop.status === "active" ? "success" : "warning";
    const label = safeSingleLine(loop.dynamic?.goal ?? loop.prompt) || "untitled loop";
    const details = [safeSingleLine(formatTrigger(loop.trigger)), `${loop.fireCount ?? 0}${loop.maxFires ? `/${loop.maxFires}` : ""} fires`].join(" · ");
    return row(selected, `${this.theme.fg(color, icon)} #${safeSingleLine(loop.id)}  ${label}`, details, width, this.theme);
  }

  private renderDetails(items: DashboardItem[], width: number): string[] {
    const item = items.find((candidate) => candidate.key === this.selectedKey);
    if (!item) return [];
    const lines = item.kind === "monitor" ? monitorDetails(item.monitor) : loopDetails(item.loop);
    return [
      section("DETAILS", width, this.theme),
      ...lines.slice(0, 5).map((line) => truncateToWidth(this.theme.fg("dim", line), width)),
    ];
  }

  private renderMessage(width: number): string {
    const pending = this.pendingAction && this.pendingAction.expiresAt > Date.now()
      ? this.pendingAction.action === "delete"
        ? "Press d again to delete this loop"
        : "Press s again to stop this monitor"
      : this.message ?? this.snapshotError ?? "Ready. Select an item; Escape closes.";
    return truncateToWidth(this.theme.fg("warning", safeSingleLine(pending)), width);
  }

  private renderFooter(width: number): string {
    const claimed = this.configuredSelectionKeys();
    const up = this.keyLabel([
      ...this.effectiveBindingKeys("tui.select.up"),
      ...this.effectiveFallbackKeys(["up", "k"], claimed),
    ]);
    const down = this.keyLabel([
      ...this.effectiveBindingKeys("tui.select.down"),
      ...this.effectiveFallbackKeys(["down", "j"], claimed),
    ]);
    const details = this.keyLabel([
      ...this.effectiveBindingKeys("tui.select.confirm"),
      ...this.effectiveFallbackKeys(["space", "enter", "return"], claimed),
    ]);
    const close = this.keyLabel([
      ...this.effectiveBindingKeys("tui.select.cancel"),
      ...this.effectiveFallbackKeys(["escape", "ctrl+c", "q"], claimed),
    ]);
    const navigation = `${this.keyLabel([up, down])} select`;
    const actions = [
      !claimed.has(normalizeKeyId("p")) ? "p pause/resume" : "",
      !claimed.has(normalizeKeyId("s")) ? "s stop" : "",
      !claimed.has(normalizeKeyId("d")) ? "d delete" : "",
      !claimed.has(normalizeKeyId("r")) ? "r refresh" : "",
    ].filter(Boolean);
    const full = [navigation, `${details} details`, ...actions, `${close} close`].join(" · ");
    const compactActions = ["p", "s", "d"].filter((key) => !claimed.has(normalizeKeyId(key)));
    const compact = [
      navigation,
      `${details} details`,
      compactActions.length > 0 ? `${compactActions.join("/")} action` : "",
      `${close} close`,
    ].filter(Boolean).join(" · ");
    return truncateToWidth(this.theme.fg("muted", visibleWidth(full) <= width ? full : compact), width);
  }

  private effectiveBindingKeys(binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): string[] {
    const priority = ["tui.select.cancel", "tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const;
    const bindingIndex = priority.indexOf(binding);
    const claimedEarlier = new Set(priority
      .slice(0, Math.max(0, bindingIndex))
      .flatMap((candidate) => this.keybindings.getKeys(candidate))
      .map((key) => normalizeKeyId(String(key))));
    return this.keybindings.getKeys(binding)
      .map(String)
      .filter((key) => !claimedEarlier.has(normalizeKeyId(key)));
  }

  private effectiveFallbackKeys(keys: string[], claimed: Set<string>): string[] {
    return keys.filter((key) => !claimed.has(normalizeKeyId(key)));
  }

  private keyLabel(keys: string[]): string {
    const seen = new Set<string>();
    const effective = keys.filter((key) => {
      if (key === "unbound") return false;
      const normalized = normalizeKeyId(key);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
    return effective.length > 0 ? effective.join("/") : "unbound";
  }

  private configuredSelectionKeys(): Set<string> {
    return new Set([
      ...this.keybindings.getKeys("tui.select.up"),
      ...this.keybindings.getKeys("tui.select.down"),
      ...this.keybindings.getKeys("tui.select.pageUp"),
      ...this.keybindings.getKeys("tui.select.pageDown"),
      ...this.keybindings.getKeys("tui.select.confirm"),
      ...this.keybindings.getKeys("tui.select.cancel"),
    ].map((key) => normalizeKeyId(String(key))));
  }

  private toggleLoop(item: DashboardItem | undefined): void {
    if (this.lastRenderWidth < MIN_ACTION_WIDTH) {
      this.setMessage("Widen terminal before changing loops");
      return;
    }
    if (!this.selectionVisible) {
      this.setMessage("Make terminal taller to act on a selection");
      return;
    }
    if (item?.kind !== "loop") {
      this.setMessage("Select a loop to pause or resume");
      return;
    }
    this.pendingAction = undefined;
    if (item.loop.status === "active") {
      const paused = this.actions.pauseLoop(item.loop.id);
      const id = safeSingleLine(item.loop.id);
      this.setMessage(paused ? `Loop #${id} paused` : `Loop #${id} is no longer available`);
    } else {
      const resumed = this.actions.resumeLoop(item.loop.id);
      const id = safeSingleLine(item.loop.id);
      this.setMessage(resumed ? `Loop #${id} resumed` : `Loop #${id} cannot be resumed`);
    }
  }

  private confirmDelete(item: DashboardItem | undefined): void {
    if (!this.selectionVisible) {
      this.setMessage("Make terminal taller to act on a selection");
      return;
    }
    if (this.lastRenderWidth < MIN_ACTION_WIDTH) {
      this.setMessage("Widen terminal before deleting");
      return;
    }
    if (item?.kind !== "loop") {
      this.setMessage("Select a loop to delete");
      return;
    }
    if (this.pendingAction?.action === "delete" && this.pendingAction.key === item.key && this.pendingAction.expiresAt > Date.now()) {
      this.pendingAction = undefined;
      const deleted = this.actions.deleteLoop(item.loop.id);
      const id = safeSingleLine(item.loop.id);
      this.setMessage(deleted ? `Loop #${id} deleted` : `Loop #${id} is no longer available`);
      return;
    }
    this.pendingAction = { action: "delete", key: item.key, expiresAt: Date.now() + CONFIRMATION_MS };
  }

  private async confirmStop(item: DashboardItem | undefined): Promise<void> {
    if (!this.selectionVisible) {
      this.setMessage("Make terminal taller to act on a selection");
      return;
    }
    if (this.lastRenderWidth < MIN_ACTION_WIDTH) {
      this.setMessage("Widen terminal before stopping");
      return;
    }
    if (item?.kind !== "monitor" || item.monitor.status !== "running") {
      this.setMessage("Select a running monitor to stop");
      return;
    }
    if (this.busy) return;
    if (this.pendingAction?.action !== "stop" || this.pendingAction.key !== item.key || this.pendingAction.expiresAt <= Date.now()) {
      this.pendingAction = { action: "stop", key: item.key, expiresAt: Date.now() + CONFIRMATION_MS };
      return;
    }
    this.pendingAction = undefined;
    this.busy = true;
    const id = safeSingleLine(item.monitor.id);
    this.setMessage(`Stopping monitor #${id}…`);
    try {
      const stopped = await this.actions.stopMonitor(item.monitor.id);
      this.setMessage(stopped ? `Monitor #${id} stopped` : `Monitor #${id} is no longer running`);
    } catch {
      this.setMessage(`Monitor #${id} could not be stopped`);
    } finally {
      this.busy = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  private setMessage(message: string): void {
    if (this.disposed) return;
    this.message = message;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = undefined;
      if (!this.disposed) this.tui.requestRender();
    }, 3_000);
    this.messageTimer.unref?.();
  }
}

function buildRenderedIndexes(items: DashboardItem[]): Map<string, number> {
  const indexes = new Map<string, number>();
  let line = 0;
  const monitors = items.filter((item) => item.kind === "monitor");
  const loops = items.filter((item) => item.kind === "loop");
  if (monitors.length > 0) {
    line += 1;
    for (const item of monitors) indexes.set(item.key, line++);
  }
  if (loops.length > 0) {
    if (monitors.length > 0) line += 1;
    line += 1;
    for (const item of loops) indexes.set(item.key, line++);
  }
  return indexes;
}

function section(label: string, width: number, theme: Theme): string {
  return truncateToWidth(theme.fg("accent", theme.bold(label)), width);
}

function row(selected: boolean, primary: string, secondary: string, width: number, theme: Theme): string {
  const prefix = selected ? theme.fg("accent", "▶ ") : "  ";
  const secondaryText = secondary ? theme.fg("dim", `  ${secondary}`) : "";
  return truncateToWidth(`${prefix}${primary}${secondaryText}`, width);
}

function monitorDetails(monitor: MonitorEntry): string[] {
  const activityAt = Math.max(monitor.startedAt, monitor.lastActivityAt ?? 0, monitor.lastOutputAt ?? 0, monitor.progress?.updatedAt ?? 0);
  const completedAt = monitor.completedAt ?? Date.now();
  const status = [`Status: ${monitor.status}`, monitor.exitCode === undefined ? "" : `exit ${monitor.exitCode}`, monitor.stopReason ? `reason ${monitor.stopReason}` : ""].filter(Boolean).join(" · ");
  const progress = formatProgress(monitor);
  const output = monitor.outputBuffer.slice(-2).map((line) => `Output: ${safeSingleLine(line)}`);
  return [
    status,
    `Command: ${safeSingleLine(monitor.command)}`,
    `Elapsed: ${formatDuration(completedAt - monitor.startedAt)} · Last activity: ${formatDuration(Date.now() - activityAt)} ago · ${monitor.outputLines} lines`,
    ...(progress ? [`Progress: ${progress}`] : []),
    ...(monitor.reportedOutcome ? [`Reported: ${safeSingleLine(monitor.reportedOutcome.status)}${monitor.reportedOutcome.message ? ` · ${safeSingleLine(monitor.reportedOutcome.message)}` : ""}`] : []),
    ...output,
  ];
}

function loopDetails(loop: LoopEntry): string[] {
  const dynamic = loop.dynamic;
  return [
    `Status: ${loop.status} · Trigger: ${safeSingleLine(formatTrigger(loop.trigger))} · Fires: ${loop.fireCount ?? 0}${loop.maxFires ? `/${loop.maxFires}` : ""}`,
    `Prompt: ${safeSingleLine(loop.prompt)}`,
    `Created: ${new Date(loop.createdAt).toLocaleString()} · Expires: ${new Date(loop.expiresAt).toLocaleString()}`,
    ...(dynamic?.state ? [`State: ${safeSingleLine(dynamic.state)}`] : []),
    ...(dynamic?.metrics ? [`Metrics: ${safeSingleLine(dynamic.metrics)}`] : []),
  ];
}

function formatProgress(monitor: MonitorEntry): string | undefined {
  const progress = monitor.progress;
  if (!progress) {
    if (monitor.status !== "running") return undefined;
    const activityAt = Math.max(monitor.startedAt, monitor.lastActivityAt ?? 0, monitor.lastOutputAt ?? 0);
    const quiet = Date.now() - activityAt;
    return quiet >= 60_000 ? `quiet ${formatDuration(quiet)}` : monitor.outputRatePerMinute ? `${monitor.outputRatePerMinute} lines/min` : "running";
  }
  const ratio = progress.current !== undefined && progress.total !== undefined && progress.total > 0
    ? `${Math.round((progress.current / progress.total) * 100)}%`
    : progress.current === undefined ? undefined : String(progress.current);
  return [ratio, safeSingleLine(progress.message ?? "")].filter(Boolean).join(" · ") || "running";
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function normalizeKeyId(key: string): string {
  const modifierRank = new Map([["ctrl", 0], ["alt", 1], ["shift", 2], ["super", 3]]);
  const aliases: Record<string, string> = {
    control: "ctrl",
    option: "alt",
    meta: "super",
    cmd: "super",
    command: "super",
    return: "enter",
    esc: "escape",
  };
  const parts = key.trim().toLowerCase().split("+").filter(Boolean).map((part) => aliases[part] ?? part);
  const modifiers = [...new Set(parts.filter((part) => modifierRank.has(part)))]
    .sort((left, right) => modifierRank.get(left)! - modifierRank.get(right)!);
  const base = parts.filter((part) => !modifierRank.has(part)).map((part) => aliases[part] ?? part).join("+");
  const canonical = [...modifiers, base].filter(Boolean).join("+");
  const terminalAliases: Record<string, string> = {
    "ctrl+[": "escape",
    "ctrl+m": "enter",
    "ctrl+j": "enter",
    "ctrl+i": "tab",
    "ctrl+h": "backspace",
    "ctrl+_": "ctrl+-",
  };
  return terminalAliases[canonical] ?? canonical;
}

function errorMessage(error: unknown): string {
  return safeSingleLine(error instanceof Error ? error.message : String(error)) || "unknown error";
}

function safeSingleLine(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (character === "\n" || character === "\r" || character === "\t") return " ";
      if (code <= 31 || (code >= 127 && code <= 159)) return `\\x${code.toString(16).padStart(2, "0")}`;
      return character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
