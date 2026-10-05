# pi-loop-monitor

A Pi extension that provides persistent agent wake loops and background command monitors. It requires Pi 0.84.3 or newer.

This project was adapted from [trvon/pi-loop](https://github.com/trvon/pi-loop) and reduced to the loop and monitor features. It does not include workflows, task queues, task RPC, subagent orchestration, or controller routing.

## Installation

Read-only wakes require the Pi Ask guard. Install `@abhishek944/pi-ask@0.2.0` or newer first. To use this checkout before its npm release, run `npm run build` and `pi install /absolute/path/to/pi-loop-monitor` (personal scope), then run `/reload` in Pi. Once published to npm, install `pi-loop-monitor@0.2.4` instead.

## Surface

Commands:

- `/loop` — create and manage scheduled, event, hybrid, and dynamic loops
- `/monitors` — open a BTW-style overlay for all loops and background monitors

Tools:

- `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete`
- `MonitorCreate`, `MonitorList`, `MonitorUpdate`, `MonitorStop`

## Examples

```text
/loop 5m check the deploy
/loop event build:done inspect the build result
/loop finish the release checklist

LoopCreate trigger="0 9 * * 1-5" prompt="Review weekday alerts" maxFires=10
LoopCreate trigger="idle" triggerType="idle" prompt="Finish the release checklist"
LoopUpdate id="1" status="continue" state="Tests pass" nextInterval="5m"
LoopList

MonitorCreate command="npm run build" onDone="Inspect the build result and fix failures"
MonitorCreate herdrPaneId="<worker-pane-id>" onSignal="Handle the worker's state change"
MonitorList
MonitorUpdate monitorId="1" current=50 total=100 message="Halfway"
MonitorStop monitorId="1"
/monitors
```

The `/monitors` dashboard uses the same top-centered overlay shape as `pi-btw`, so the main chat remains visible behind it. It refreshes live, shows bounded loop and monitor details, and supports keyboard actions: arrows or `j`/`k` to select, `Enter` to toggle details, `p` to pause or resume a loop, `s` twice to stop a monitor, `d` twice to delete a loop, and `Escape` or `Ctrl+C` to close.

`MonitorCreate.timeout` is an inactivity timeout. Output, JSONL progress, or `MonitorUpdate` renews it. `onDone` creates a direct one-shot loop wake after completion; it does not require another controller subsystem.

For Herdr workers, `herdrPaneId` plus `onSignal` keeps one monitor subscribed to state changes, including blocked, working, idle, and done. Confirm subscription readiness in `MonitorList` before prompting; stop the monitor explicitly when finished. Each signal wakes the caller without recreating the monitor. Ordinary commands can opt into signal wakes by printing JSONL `monitorOutcome` records and supplying `onSignal`. See the usage guide for lifetime and disconnect behavior.

Recurring loops expire after seven days. Event and hybrid subscriptions from an earlier session are retired during recovery. Dynamic loops must call `LoopUpdate` once per wake.

Read-only loops use the shared guard provided by [`@abhishek944/pi-ask`](https://github.com/abhishek944/pi-ask) 0.2.0 or newer. Pi Ask must be installed and loaded. The guard removes mutating and unknown tools for the complete agent run, checks every tool call again before execution, and restores the previous tools after Pi fully settles. Dynamic read-only loops may call `LoopUpdate` only for the loop that fired. If the guard is missing, a new read-only loop is rejected and a recovered loop is paused rather than running without enforcement. A temporarily busy guard leaves the wake queued until the current restricted run settles.

Loop state is always scoped to one Pi session and persisted under `~/.pi/loops/` as `loops-<session-id>.json`. Loops are never shared between sessions.

## Development

```bash
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
git diff --check
```

See the [usage guide](docs/USAGE_GUIDE.md) and [reference](docs/REFERENCE.md).
