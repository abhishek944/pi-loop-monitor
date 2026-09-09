# pi-loop-monitor reference

## Ownership

`LoopStore` exclusively owns persisted loop state under `~/.pi/loops/`. `MonitorManager` owns process-local monitor state. Notification buffers are memory-only. This package has no task store, task or subagent RPC, workflow state, orchestration state, or controller-routing runtime.

## Loops

Triggers are cron, event, hybrid, or dynamic. Loops can be active or paused and may have an administrative or controller-limit pause record. Recurring controllers expire after seven days. Event and hybrid subscriptions created in an older session are retired on recovery. Retirement emits `loops:expired` and queues a hidden idle-safe notification.

Dynamic loops preserve goal, state, metrics, done criteria, iteration, and optional next wake time. Each dynamic wake sets `awaitingUpdate`; `LoopUpdate` clears it or completes/pauses the controller with a compare-and-set guard.

Loop persistence uses PID locks with stale-owner detection, unique temporary snapshots, file and directory fsync, atomic rename, and previous-snapshot recovery. Corruption fails visibly when no valid snapshot remains.

Loops are always session-scoped and persisted as `~/.pi/loops/loops-<session-id>.json`; they are never shared between Pi sessions. There is no memory-only or shared-file mode.

## Interactive dashboard

`/monitors` opens a top-centered, BTW-style overlay in interactive mode, leaving Pi's main chat visible behind it. It reads live snapshots through `LoopStore` and `MonitorManager`; it does not introduce another state owner. The dashboard can pause, resume, or delete loops through the store and trigger system, and can stop running monitors through the manager. Destructive stop and delete actions require confirmation. Closing the overlay returns focus to Pi's main TUI.

## Monitors

Monitors run detached process groups, retain bounded output, rate-limit output events, and support trustworthy structured progress. The timeout is based on inactivity; output and progress renew it. Manual stop sends TERM and then KILL after five seconds when needed.

`onDone` creates an ordinary one-shot event loop and registers a direct monitor callback. The callback checks the current extension generation before firing and deletes the completion loop after delivery. A monitor without `onDone` gets a timeout-only alert loop when its inactivity timeout is enabled. Monitor processes are stopped and reaped before session replacement; monitor recovery across Pi process death is not supported.

Events: `monitor:started`, `monitor:output`, `monitor:finished`, `monitor:done`, `monitor:error`, `loop:fire`, and `loops:expired`.

## Limits

- 25 loops
- 25 running monitors
- seven-day loop lifetime
- five-minute default monitor inactivity timeout
