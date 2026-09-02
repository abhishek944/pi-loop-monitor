# Changelog

## 0.7.11-local.0

- Forked upstream pi-loop 0.7.11 as the private local `pi-loop-monitor` package.
- Retained cron, event, hybrid, and dynamic loop controllers, persistence, idle-safe notifications, expiry, and lifecycle fencing.
- Retained background monitors, structured progress, inactivity timeouts, process-tree teardown, and direct `onDone` wakes.
- Removed all non-loop and non-monitor runtime, storage, tool, command, API, documentation, test, benchmark, and packaging surfaces.
