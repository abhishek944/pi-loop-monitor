# Changelog

## 0.2.9 - 2026-10-21

- Expose `details.monitorId` on successful `MonitorCreate` results so wrappers can return the allocated ID without parsing display text; monitoring and callback behavior are unchanged.
- Rename the npm package to `@abhishek944/pi-loop-monitor` and declare public publishing access. Existing `pi-loop-monitor` installations must migrate explicitly after the scoped package is published; runtime identifiers and state paths are unchanged.

## 0.2.8 - 2026-10-17

- Replace queued per-event monitor signal wakes with one latest-state mailbox per monitor subscription and a compatible idle digest; consecutive identical reported states no longer enqueue notification work.
- Drop queued monitor and loop notices when their source is stopped, paused, deleted, explicitly completed, or automatically expired, while preserving automatic one-shot completion receipts and monitor output history.
- Revalidate pending notices at delivery against their source lifecycle: expired loops, advanced dynamic iterations, paused/stopped monitors, and dismissed terminal wakes are dropped without replaying stale instructions; `MonitorStop` can dismiss a pending terminal wake for an already-finished or pruned monitor.

## 0.2.7 - 2026-10-17

- Prepare the dedicated full-output monitor feature for npm distribution under a fresh patch version; runtime behavior is unchanged from 0.2.6.

## 0.2.6 - 2026-10-16

- Open a dedicated live output window for a selected monitor, with Escape returning to the loops and monitors overview.
- Capture complete command stdout/stderr in private temporary logs, with wrapped history browsing and bounded in-memory reads.
- Preserve blank lines, long lines, and partial output; sanitize terminal controls and clean up logs with the monitor lifecycle.

## 0.2.5 - 2026-10-05

- Upgrade Pi development dependencies to 1.0.2 to resolve vulnerable shrinkwrapped `brace-expansion` and `undici` copies.
- Keep runtime peer requirements and the full prepublish audit gate unchanged.

## 0.2.4 - 2026-10-05

- Keep one monitor subscribed to all Herdr worker state changes with `herdrPaneId` and `onSignal`.
- Wake on every JSONL command-reported outcome without ending the monitor or overwriting earlier queued signals.
- Clean up signal subscriptions on monitor termination and wake on Herdr connection failures.

## 0.2.3 - 2026-09-28

- Pass an optional command-reported JSONL outcome separately from the monitor's process status and exit code.
- Show reported outcomes in monitor listings and dashboard, completion events, and `onDone` wakes.

## 0.2.2 - 2026-09-12

- Enforce `readOnly` loop wakes through the reusable Pi Ask guard instead of relying only on prompt instructions.
- Restrict dynamic read-only wakes to `LoopUpdate` calls for the firing loop and fail closed when the guard is unavailable.

## 0.2.1 - 2026-09-09

- Store loop state centrally under `~/.pi/loops/` instead of repository-local `.pi/loops/`.
- Make loops strictly session-scoped, remove project and memory-only scopes, and remove custom shared store paths.

## 0.2.0

- Added `/monitors`, a Pi BTW-style top-centered overlay for viewing loops and background monitors while keeping the chat visible.
- Added live details, responsive keyboard navigation, loop pause/resume/delete actions, and monitor stop actions with destructive-action confirmation.
- Hardened monitor shutdown coordination, loop resume guards, overlay cleanup, terminal-output sanitization, and configurable keybinding hints.

## 0.1.1

- Dynamic goal loops created with `/loop <goal>` no longer default to `maxFires: 20`; they run unbounded unless a fire limit is passed explicitly (e.g. via `LoopCreate` `maxFires`).

## 0.1.0

- Initial private release of `pi-loop-monitor`.
- Retained cron, event, hybrid, and dynamic loop controllers, persistence, idle-safe notifications, expiry, and lifecycle fencing.
- Retained background monitors, structured progress, inactivity timeouts, process-tree teardown, and direct `onDone` wakes.
- Removed all non-loop and non-monitor runtime, storage, tool, command, API, documentation, test, benchmark, and packaging surfaces.
