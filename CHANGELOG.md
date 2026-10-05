# Changelog

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
