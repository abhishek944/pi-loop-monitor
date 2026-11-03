import { View, div, svg } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { readFile } from "fs/promises";
import { agents, panes, props, settings, shared, terminals, theme, watchFolder } from "herdr";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const string = (v) => typeof v === "string";
const optionalText = (v) => v === undefined || string(v);
const optionalNumber = (v) => v === undefined || integer(v);
const duration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return s < 60 ? s + "s" : m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${h}h ${String(m % 60).padStart(2, "0")}m`;
};
const state = (loop) => loop.status === "paused" ? "Paused" : loop.dynamic?.awaitingUpdate ? "Awaiting update" : "Waiting";
const trigger = (loop) => {
  const t = loop.trigger;
  if (t.type === "dynamic") return "Idle-driven";
  if (t.type === "event") return t.source === "idle" ? "When idle" : t.source === "tool_execution_end" ? "After tool ends" : "On " + t.source;
  const natural = (s) => {
    const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(s);
    if (minutes) return "Every " + minutes[1] + "m";
    if (s === "0 * * * *") return "Every hour";
    return /^(?:\d+)(?:ms|s|m|h|d)$/.test(s) ? "Every " + s : s;
  };
  return t.type === "cron" ? natural(t.schedule) : natural(t.cron) + " + " + t.event.source;
};

function validate(v, binding) {
  const invalid = () => { throw new Error("Invalid or mismatched activity snapshot. Reopen with /monitors herdr from this Pi session."); };
  if (!object(v) || v.version !== 1 || v.source !== "pi-loop-monitor" || v.sessionId !== binding.sessionId || v.runtimeId !== binding.runtimeId
    || v.terminal !== binding.terminal || !integer(v.pid) || v.pid === 0 || !integer(v.updatedAt) || typeof v.live !== "boolean"
    || !Array.isArray(v.loops) || v.loops.length > 25 || !Array.isArray(v.monitors) || v.monitors.length > 100 || !integer(v.omittedMonitors)) invalid();
  const ids = new Set();
  for (const l of v.loops) {
    if (!object(l) || !string(l.id) || ids.has(l.id) || !string(l.prompt) || !["active", "paused"].includes(l.status)
      || !optionalNumber(l.fireCount) || !optionalNumber(l.maxFires) || !object(l.trigger)) invalid();
    ids.add(l.id);
    const t = l.trigger;
    if (!(t.type === "dynamic" || t.type === "cron" && string(t.schedule) || t.type === "event" && string(t.source)
      || t.type === "hybrid" && string(t.cron) && object(t.event) && string(t.event.source))) invalid();
    if (l.pause !== undefined && (!object(l.pause) || !optionalText(l.pause.reason))) invalid();
    const d = l.dynamic;
    if (d !== undefined && (!object(d) || !string(d.goal) || !optionalText(d.state) || !optionalText(d.metrics) || !optionalText(d.doneCriteria)
      || !integer(d.iteration) || !optionalNumber(d.nextWakeAt) || d.awaitingUpdate !== undefined && typeof d.awaitingUpdate !== "boolean")) invalid();
  }
  ids.clear();
  for (const m of v.monitors) {
    if (!object(m) || !string(m.id) || ids.has(m.id) || !string(m.command) || !optionalText(m.description) || !["running", "completed", "error", "stopped"].includes(m.status)
      || !integer(m.startedAt) || !optionalNumber(m.completedAt) || m.exitCode !== undefined && !Number.isInteger(m.exitCode)
      || !optionalText(m.stopReason) || typeof m.subscription !== "boolean" || !Array.isArray(m.output) || m.output.length > 3 || !m.output.every(string)
      || m.reportedOutcome !== undefined && (!object(m.reportedOutcome) || !string(m.reportedOutcome.status) || !optionalText(m.reportedOutcome.message))) invalid();
    ids.add(m.id);
  }
  if (v.error !== undefined) { if (!string(v.error)) invalid(); throw new Error(v.error); }
  return v;
}

export default class Activity extends View {
  init(_props, cx) {
    this.binding = props() ?? {};
    this.document = null; this.error = ""; this.closed = false; this.loading = false; this.expanded = new Set(); this.width = 800;
    const b = this.binding;
    if (!string(b.sessionId) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(b.sessionId) || !string(b.runtimeId)
      || !string(b.snapshot) || !b.snapshot.startsWith("/") || b.snapshot.includes("\0") || !/^t[0-9a-z]+$/.test(b.terminal)) {
      this.error = "Reopen this view from its Pi session with /monitors herdr."; return;
    }
    cx.spawn(async (cx) => {
      await this.reload(cx);
      try {
        while (!this.closed) {
          const paths = await watchFolder(b.snapshot.replace(/\/[^/]+$/, ""));
          if (this.closed) return;
          if (paths.includes(b.snapshot)) await this.reload(cx);
        }
      } catch { if (!this.closed) { this.error = "Live activity updates unavailable."; cx.notify(); } }
    });
    // Measured process time only; spin is native. Also expires freshness without a write.
    cx.timer.every(1000, (cx) => {
      const fresh = this.fresh();
      const ticking = this.section() === "monitors" ? this.document?.monitors.some((m) => m.status === "running")
        : this.document?.loops.some((l) => l.status === "active" && l.dynamic?.nextWakeAt !== undefined && !l.dynamic.awaitingUpdate);
      if (fresh !== this.lastFresh || fresh && ticking) cx.notify();
      this.lastFresh = fresh;
    });
  }
  close() { this.closed = true; }
  async reload(cx) {
    if (this.loading) { this.pending = true; return; }
    this.loading = true;
    try {
      // Herdr readTextFile is capped at 1 MiB; this private local projection allows 4 MiB.
      const content = await readFile(this.binding.snapshot, "utf8");
      if (content.length > 4 * 1024 * 1024) throw new Error("Activity snapshot exceeds 4 MiB.");
      const next = validate(JSON.parse(content), this.binding);
      if (this.document && next.pid !== this.document.pid) throw new Error("Activity source process changed. Reopen from Pi.");
      if (next.live || !this.document) this.document = next;
      this.error = next.live ? "" : "Activity runtime closed.";
      const ids = new Set([...next.loops.map((l) => "loop-" + l.id), ...next.monitors.map((m) => "monitor-" + m.id)]);
      if (next.live) for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally {
      this.loading = false;
      if (!this.closed) { cx.notify(); if (this.pending) { this.pending = false; await this.reload(cx); } }
    }
  }
  fresh() {
    const d = this.document;
    return !!d && !this.error && d.live && Date.now() >= d.updatedAt - 5000 && Date.now() - d.updatedAt < 65000
      && terminals().some((t) => t.address === this.binding.terminal && t.state === "live")
      && agents().some((agent) => agent.address === this.binding.terminal && agent.app === "pi");
  }
  pane() {
    const all = panes();
    if (this.boundPane && all.some((p) => p.pane === this.boundPane && p.mod === "pi-loop-monitor" && p.terminal === null)) return this.boundPane;
    const source = all.find((p) => p.terminal === this.binding.terminal);
    const matches = all.filter((p) => p.mod === "pi-loop-monitor" && p.terminal === null && p.tab === source?.tab);
    if (matches.length !== 1) return null;
    // Keep this exact local identity when the source terminal later disappears.
    this.boundPane = matches[0].pane;
    return this.boundPane;
  }
  section() {
    const pane = this.pane();
    return pane && shared("pi-activity-section:" + pane) === "monitors" ? "monitors" : "loops";
  }
  text(value, size, color) {
    // Zero-width wrapping opportunities keep long shell tokens/output within the pane.
    return div().min_w(0).whitespace_normal().text_size(size).text_color(color).child(String(value).replace(/([^\s]{32})(?=[^\s])/gu, "$1\u200b"));
  }
  field(label, value, t) {
    return v_flex().gap(2).min_w(0).child(this.text(label, 10, t.dim)).child(this.text(value, this.width < 450 ? 11 : 12, t.muted));
  }
  item(id, label, row, details, t) {
    const open = this.expanded.has(id);
    const item = v_flex().min_w(0).w_full().role("group").accessibility_label(label);
    item.child(Button.new("activity-" + id).w_full().h(30).px(this.width < 450 ? 5 : 10).rounded(5)
      .border(1).border_color(open ? t.selected : t.background).selected(open).tab_stop(true)
      .bg(open ? t.selected : t.background).hover((s) => s.bg(t.hover)).focus((s) => s.bg(t.selected).border_color(t.accent))
      .accessibility_label(label + (open ? "; details expanded" : "; details collapsed")).tooltip(label).cursor_pointer()
      .on_click((_event, cx) => { if (open) this.expanded.delete(id); else this.expanded.add(id); cx.notify(); }).child(row));
    if (open) item.child(details.role("group").accessibility_label("Details: " + label));
    return item;
  }
  loop(loop, fresh, t) {
    const id = "loop-" + loop.id, narrow = this.width < 450, label = loop.dynamic?.goal || loop.prompt.replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0];
    const status = state(loop), caption = trigger(loop);
    const glyph = loop.status === "paused" ? "Ⅱ" : loop.dynamic?.awaitingUpdate ? "↪" : "○";
    const row = h_flex().w_full().min_w(0).items_center().gap(narrow ? 6 : 8)
      .child(div().w(12).flex_none().text_size(12).text_color(t.muted).child(glyph))
      .child(div().min_w(0).truncate().font_medium().text_size(narrow ? 11 : 12.5).text_color(t.foreground).child(label))
      .child(div().flex_none().text_size(narrow ? 9 : 11).text_color(t.dim).child("· " + loop.id))
      .child(div().flex_1().min_w(0))
      .child(div().flex_none().max_w(narrow ? 125 : 240).truncate().text_size(narrow ? 10 : 11).text_color(t.muted).child(caption));
    const facts = [status, `${loop.fireCount ?? 0}${loop.maxFires === undefined ? "" : "/" + loop.maxFires} fires`];
    if (loop.dynamic) {
      facts.push("iteration " + loop.dynamic.iteration);
      if (loop.status === "active" && !loop.dynamic.awaitingUpdate) facts.push(loop.dynamic.nextWakeAt === undefined ? "Next when idle" : fresh ? "Next in " + duration(Math.max(0, loop.dynamic.nextWakeAt - Date.now())) : "Next wake " + new Date(loop.dynamic.nextWakeAt).toLocaleString());
    }
    const detail = v_flex().min_w(0).ml(15).pl(15).pr(10).pt(8).pb(13).mb(6).gap(8).border_l(1).border_color(t.border)
      .child(this.field("Prompt", loop.prompt, t)).child(this.text(facts.join(" · "), 10, t.muted));
    if (loop.dynamic?.state) detail.child(this.field("State", loop.dynamic.state, t));
    if (loop.dynamic?.metrics) detail.child(this.field("Metrics", loop.dynamic.metrics, t));
    if (loop.dynamic?.doneCriteria) detail.child(this.field("Done when", loop.dynamic.doneCriteria, t));
    if (loop.pause?.reason) detail.child(this.field("Pause reason", loop.pause.reason, t));
    return this.item(id, `Loop ${loop.id}; ${loop.dynamic?.goal || loop.prompt}; ${status}; ${caption}; trigger ${JSON.stringify(loop.trigger)}; ${this.expanded.has(id) ? "Collapse" : "Expand"} loop details`, row, detail, t);
  }
  monitor(m, fresh, t) {
    const narrow = this.width < 450, label = m.description || m.command;
    const font = settings().font;
    const codeFont = typeof font === "string" ? font : "JetBrains Mono";
    const at = m.status === "running" ? fresh ? Date.now() : this.document.updatedAt : m.completedAt;
    const elapsed = duration(at === undefined ? NaN : Math.max(0, at - m.startedAt));
    const mark = m.status === "running" && fresh ? svg("mods/pi-loop-monitor/spinner.svg").size(10).spin(900).text_color(t.accent)
      : div().w(10).text_size(11).text_color(t.muted).child(m.status === "running" ? "○" : m.status === "completed" ? "✓" : m.status === "error" ? "!" : "■");
    const row = h_flex().w_full().min_w(0).items_center().gap(narrow ? 7 : 8).child(mark.flex_none())
      .child(div().flex_1().min_w(0).truncate().font_medium().text_size(narrow ? 11 : 12.5).text_color(t.foreground).child(label))
      .child(div().flex_none().text_size(narrow ? 10 : 11).text_color(t.muted).child(elapsed));
    const detail = v_flex().min_w(0).ml(narrow ? 13 : 28).pl(narrow ? 23 : 14).pr(7).pt(8).pb(17).mb(8).gap(5).border_l(1).border_color(t.border);
    detail.child(h_flex().min_w(0).gap(4).items_start()
      .child(this.text("Command", 10, t.dim).flex_none())
      .child(this.text(m.command, 10, t.muted).font_family(codeFont).flex_1()));
    detail.child(this.text(["Process " + m.status, m.exitCode === undefined ? "" : "exit " + m.exitCode, m.stopReason || "", elapsed].filter(Boolean).join(" · "), 11, t.muted));
    if (m.reportedOutcome) detail.child(this.text("Reported " + m.reportedOutcome.status + (m.reportedOutcome.message ? " — " + m.reportedOutcome.message : ""), 11, t.muted));
    if (m.subscription) detail.child(this.text("Subscription signals, not the worker transcript.", 10, t.dim));
    detail.child(this.text("Recent output", 11, t.dim));
    if (m.output.length) detail.child(v_flex().min_w(0).children(m.output.map((line) => this.text(line, 10, t.muted).font_family(codeFont).line_height("16.5px"))));
    else detail.child(this.text("No output yet.", 10, t.muted));
    detail.child(this.text("Temporary output · full output in /monitors", 10, t.dim));
    return this.item("monitor-" + m.id, `${label}; Process ${m.status}${fresh ? "" : "; last known"}; ${elapsed}; ${this.expanded.has("monitor-" + m.id) ? "Collapse" : "Expand"} monitor details`, row, detail, t);
  }
  render() {
    const t = theme(), fresh = this.fresh(), pane = this.pane(), section = this.section();
    const root = v_flex().id("activity-root").size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } });
    const list = v_flex().id("activity-list-" + section).role("tab_panel").accessibility_label(section === "loops" ? "Loops" : "Monitors").size_full().min_h(0).min_w(0).overflow_y_scrollbar().pt(22).pb(20).px(this.width < 450 ? 10 : 20);
    if (!pane) list.child(this.text(this.error || "Activity pane identity unavailable. Close this view and reopen it from Pi with /monitors herdr.", 12, t.muted));
    else if (!this.document) list.child(this.text(this.error || "Loading activity…", 12, t.muted));
    else {
      if (!fresh) list.child(this.text("Updates unavailable. Last snapshot; process state may be outdated.", 11, t.dim).mb(10));
      const entries = this.document[section];
      if (!entries.length) list.child(this.text(fresh ? `No ${section} in this session.` : `${section === "loops" ? "Loops" : "Monitors"} unavailable. Use /monitors in Pi to inspect this session.`, 12, t.muted));
      list.children(entries.map((entry) => section === "loops" ? this.loop(entry, fresh, t) : this.monitor(entry, fresh, t)));
      if (section === "monitors" && this.document.omittedMonitors) list.child(this.text("Older temporary monitors omitted. Use /monitors in Pi.", 10, t.dim));
    }
    return root.child(list);
  }
}
