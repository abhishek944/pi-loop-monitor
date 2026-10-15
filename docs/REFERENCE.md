# pi-loop-monitor reference

## Ownership

`LoopStore` exclusively owns persisted loop state under `~/.pi/loops/`. `MonitorManager` owns process-local monitor state. Notification buffers are memory-only; when a session shuts down, discarded one-shot and final bounded read-only notifications retire their controllers instead of leaving already-fired state to run again. This package has no task store, task or subagent RPC, workflow state, orchestration state, or controller-routing runtime.

## Loops

Triggers are cron, event, hybrid, or dynamic. Loops can be active or paused and may have an administrative or controller-limit pause record. Recurring controllers expire after seven days. Event and hybrid subscriptions created in an older session are retired on recovery. Retirement emits `loops:expired` and queues a hidden idle-safe notification.

Dynamic loops preserve goal, state, metrics, done criteria, iteration, and optional next wake time. Each dynamic wake sets `awaitingUpdate`; `LoopUpdate` clears it or completes/pauses the controller with a compare-and-set guard.

Read-only wakes acquire guard protocol version 1 from the separately loaded `@abhishek944/pi-ask` extension before notification delivery. The guard narrows active tools and enforces the same rules again at `tool_call`. Approved tools are repository reads, bounded web lookups, `LoopList`, and `MonitorList`; dynamic wakes additionally receive `LoopUpdate` constrained to the firing loop ID. Guard acquisition is acknowledged synchronously. A busy guard leaves the wake queued until the active restricted run settles. A missing or invalid guard fails closed: creation is rejected when possible, and recovered loops are paused rather than delivered unrestricted. Pi Ask owns restoration on `agent_settled` and session shutdown.

Loop persistence uses PID locks with stale-owner detection, unique temporary snapshots, file and directory fsync, atomic rename, and previous-snapshot recovery. Corruption fails visibly when no valid snapshot remains.

Loops are always session-scoped and persisted as `~/.pi/loops/loops-<session-id>.json`; they are never shared between Pi sessions. There is no memory-only or shared-file mode.

## Interactive dashboard

`/monitors` opens a top-centered, BTW-style overlay in interactive mode, leaving Pi's main chat visible behind it. It reads live snapshots through `LoopStore` and `MonitorManager`; it does not introduce another state owner. The dashboard can pause, resume, or delete loops through the store and trigger system, and can stop running monitors through the manager. Destructive stop and delete actions require confirmation. Closing the overlay returns focus to Pi's main TUI.

## Monitors

Monitors run detached process groups, retain bounded output, rate-limit output events, and support trustworthy structured progress. The timeout is based on inactivity; output and progress renew it. Manual stop sends TERM and then KILL after five seconds when needed. Commands can optionally emit JSONL `{"monitorOutcome":{"status":"blocked","message":"..."}}`; the last valid command-reported outcome is stored separately from the monitor's process status and exit code. This report is untrusted and is passed to `MonitorList`, completion events, and the `onDone` wake. Commands without a report remain unchanged.

`onDone` creates an ordinary one-shot event loop and registers a direct monitor callback. The callback checks the current extension generation before firing and deletes the completion loop after delivery. A monitor without `onDone` gets a timeout-only alert loop when its inactivity timeout is enabled. Monitor processes are stopped and reaped before session replacement; monitor recovery across Pi process death is not supported.

`onSignal` creates a recurring signal controller scoped to the monitor. Each valid JSONL outcome record emits `monitor:signal` and queues a distinct idle-safe wake; signal records do not change process status or finish the monitor. Terminal cleanup unsubscribes and deletes the signal controller. Signal controllers retain ordinary pause/delete and seven-day expiry behavior.

`herdrPaneId` selects a long-lived child command connected to the Herdr socket API `events.subscribe` with a pane-scoped `pane.agent_status_changed` subscription. It requires `onSignal`, defaults to no inactivity timeout, and automatically creates a terminal wake for connection failures. It uses the same process-group stop/shutdown boundary as shell monitors. No polling, state replay, automatic reconnect, or cross-process monitor recovery is introduced.

Events: `monitor:started`, `monitor:output`, `monitor:signal`, `monitor:finished`, `monitor:done`, `monitor:error`, `loop:fire`, and `loops:expired`.

## Limits

- 25 stored loops per session (hard limit, including active, paused, and monitor wake loops)
- 25 running monitors
- seven-day loop lifetime
- five-minute default monitor inactivity timeout

`LoopCreate.maxFires` is an optional per-loop fire-count limit (integer >= 1), separate from the hard 25-loop capacity. When omitted, there is no fire-count limit; other lifecycle conditions still apply.
