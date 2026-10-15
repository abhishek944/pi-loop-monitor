import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MonitorOutputPage } from "../monitor-output-log.js";
import type { MonitorEntry } from "../types.js";

/** One isolated monitor screen; the dashboard owns its refresh and back navigation. */
export class MonitorOutputView {
  private page: MonitorOutputPage | undefined;
  private following = true;
  private offset = 0;
  private row = 0;
  private bottomOnLoad = false;
  private rows: string[] = [];
  private bodyHeight = 1;
  private cachedText: string | undefined;
  private cachedWidth = 0;

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly read: (offset?: number) => MonitorOutputPage,
  ) {}

  invalidate(): void {
    this.cachedText = undefined;
  }

  render(width: number, height: number, monitor: MonitorEntry | undefined): string[] {
    if (width < 4 || height < 10) {
      return ["Monitor output", "Enlarge terminal to read output.", "Escape: back"]
        .slice(0, height).map((line) => truncateToWidth(line, width, ""));
    }
    const inner = Math.max(1, width - 2);
    this.bodyHeight = Math.max(1, height - 9);
    let error: string | undefined;
    try {
      this.page = this.read(this.following ? undefined : this.offset);
      this.offset = this.page.start;
      if (this.cachedText !== this.page.text || this.cachedWidth !== inner) {
        this.rows = wrapTextWithAnsi(safeOutput(this.page.text), inner);
        this.cachedText = this.page.text;
        this.cachedWidth = inner;
      }
      error = this.page.error;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const maxRow = Math.max(0, this.rows.length - this.bodyHeight);
    if (this.following || this.bottomOnLoad) this.row = maxRow;
    this.bottomOnLoad = false;
    this.row = Math.max(0, Math.min(this.row, maxRow));
    const lines = this.page?.text ? this.rows.slice(this.row, this.row + this.bodyHeight) : [error ? "Output unavailable. Escape returns to the overview." : "No output yet."];
    while (lines.length < this.bodyHeight) lines.push("");
    const page = this.page;
    const position = error ? safeOutput(error).replaceAll("\n", " ") : page
      ? `${this.following ? "LIVE" : "HISTORY"} · bytes ${page.start}-${page.end} / ${page.total} · ${page.path}`
      : "Output unavailable";
    const title = monitor ? `Monitor #${monitor.id} · ${monitor.description ?? "command output"}` : "Monitor output · no longer available";
    const status = monitor ? `${monitor.status}${monitor.exitCode === undefined ? "" : ` · exit ${monitor.exitCode}`} · ${monitor.outputLines} lines · output wraps to fit` : "The monitor was removed. Escape returns to the overview.";
    const frame = (text: string) => {
      const clipped = truncateToWidth(text, inner, "");
      return `${this.theme.fg("border", "│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${this.theme.fg("border", "│")}`;
    };
    const rule = this.theme.fg("border", `├${"─".repeat(inner)}┤`);
    const result = [
      this.theme.fg("border", `┌${"─".repeat(inner)}┐`),
      frame(this.theme.fg("accent", this.theme.bold(safeOutput(title).replaceAll("\n", " ")))),
      frame(this.theme.fg("dim", status)),
      frame(this.theme.fg("dim", `Command: ${safeOutput(monitor?.command ?? "").replaceAll("\n", " ")}`)),
      rule,
      ...lines.map(frame),
      rule,
      frame(this.theme.fg(error ? "error" : "muted", safeOutput(position).replaceAll("\n", " "))),
      frame(this.theme.fg("muted", "↑/↓ j/k scroll · PgUp/PgDn page · Home start · End live · Esc back")),
      this.theme.fg("border", `└${"─".repeat(inner)}┘`),
    ];
    return result;
  }

  handleInput(data: string): void {
    const up = this.keybindings.matches(data, "tui.select.up");
    const down = this.keybindings.matches(data, "tui.select.down");
    const pageUp = this.keybindings.matches(data, "tui.select.pageUp");
    const pageDown = this.keybindings.matches(data, "tui.select.pageDown");
    if (up) this.scroll(-1);
    else if (down) this.scroll(1);
    else if (pageUp) this.scroll(-this.bodyHeight);
    else if (pageDown) this.scroll(this.bodyHeight);
    else if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.scroll(-1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.scroll(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll(-this.bodyHeight);
    else if (matchesKey(data, Key.pageDown)) this.scroll(this.bodyHeight);
    else if (matchesKey(data, Key.home)) {
      this.following = false;
      this.offset = 0;
      this.row = 0;
    } else if (matchesKey(data, Key.end)) {
      this.following = true;
    }
  }

  private scroll(amount: number): void {
    const page = this.page;
    if (!page) return;
    this.following = false;
    this.offset = page.start;
    const maxRow = Math.max(0, this.rows.length - this.bodyHeight);
    if (amount < 0 && this.row === 0 && page.start > 0) {
      this.offset = Math.max(0, page.start - 64 * 1024);
      this.bottomOnLoad = true;
    } else if (amount > 0 && this.row >= maxRow && page.end < page.total) {
      this.offset = page.end;
      this.row = 0;
    } else {
      this.row = Math.max(0, Math.min(maxRow, this.row + amount));
    }
  }
}

function safeOutput(text: string): string {
  return [...stripVTControlCharacters(text).replaceAll("\r\n", "\n")]
    .map((character) => {
      if (character === "\n") return character;
      if (character === "\r") return "\n";
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) return `\\x${code.toString(16).padStart(2, "0")}`;
      return character;
    }).join("");
}
