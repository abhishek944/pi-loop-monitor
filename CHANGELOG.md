# Changelog

## 0.1.1

- Dynamic goal loops created with `/loop <goal>` no longer default to `maxFires: 20`; they run unbounded unless a fire limit is passed explicitly (e.g. via `LoopCreate` `maxFires`).

## 0.1.0

- Initial private release of `pi-loop-monitor`.
- Retained cron, event, hybrid, and dynamic loop controllers, persistence, idle-safe notifications, expiry, and lifecycle fencing.
- Retained background monitors, structured progress, inactivity timeouts, process-tree teardown, and direct `onDone` wakes.
- Removed all non-loop and non-monitor runtime, storage, tool, command, API, documentation, test, benchmark, and packaging surfaces.
