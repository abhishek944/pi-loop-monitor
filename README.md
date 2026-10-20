# @abhishek944/pi-loop-monitor

A Pi extension that provides persistent agent wake loops and background command monitors. It requires Pi 0.84.3 or newer.

This project was adapted from [trvon/pi-loop](https://github.com/trvon/pi-loop) and reduced to the loop and monitor features. It does not include workflows, task queues, task RPC, subagent orchestration, or controller routing.

## Installation

Read-only wakes require the Pi Ask guard. Install `@abhishek944/pi-ask@0.2.0` or newer first. To use this checkout before its npm release, run `npm run build` and `pi install /absolute/path/to/pi-loop-monitor` (personal scope), then run `/reload` in Pi. Once published to npm, install the scoped package instead:

```sh
pi install npm:@abhishek944/pi-loop-monitor
```

### Migrating from the unscoped package

`@abhishek944/pi-loop-monitor` is a separate npm package from `pi-loop-monitor`. `pi update --extensions` does not migrate package names automatically. Only after the scoped package has been published and is available, stop active loops/monitors and run:

```sh
npm view @abhishek944/pi-loop-monitor version &&
  pi remove npm:pi-loop-monitor &&
  pi install npm:@abhishek944/pi-loop-monitor
```

Then run `/reload` in Pi. If the version lookup fails, do not remove the old package. For a project-local installation, use `--local` with both `pi remove` and `pi install` from that project. Replace any direct imports such as `pi-loop-monitor/api` with `@abhishek944/pi-loop-monitor/api`. The repository directory, tool names, runtime identifiers, and session-state paths are unchanged.

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

The `/monitors` dashboard uses the same top-centered overlay shape as `pi-btw`, so the main chat remains visible behind it. It refreshes live. Use arrows or `j`/`k` to select, then `Enter` to open a dedicated monitor output window (or toggle loop details). Output wraps and the complete captured command output is scrollable: arrows scroll, `PageUp`/`PageDown` page, `Home` goes to the beginning, and `End` follows live output. `Escape` returns to the overview; another `Escape` closes it. Overview actions remain `p` to pause/resume a loop, `s` twice to stop a monitor, and `d` twice to delete a loop.

Full stdout/stderr capture uses private temporary files with bounded in-memory reads. Logs are removed when the monitor is pruned (15 minutes after termination) or the session shuts down, switches, or reloads. They are not a durable archive. `MonitorList` still shows only a bounded tail. Herdr subscription monitors show subscription signals, not the worker's full transcript; use its Herdr tab for that.

`MonitorCreate.timeout` is an inactivity timeout. Output, JSONL progress, or `MonitorUpdate` renews it. `onDone` creates a direct one-shot loop wake after completion; it does not require another controller subsystem.

For Herdr workers, `herdrPaneId` plus `onSignal` keeps one monitor subscribed to state changes, including blocked, working, idle, and done. Confirm subscription readiness in `MonitorList` before prompting; stop the monitor explicitly when finished. Each monitor has one latest pending state: a newer `working`, `blocked`, `idle`, `done`, or `unknown` state replaces an older pending one, consecutive identical states do not wake again, and updates from several monitors share one idle digest. Intermediate states stay in the monitor output instead of replaying as separate wakes. Ordinary commands can opt into the same latest-state signals by printing JSONL `monitorOutcome` records and supplying `onSignal`. Stopping a monitor drops its queued signal wakes; calling `MonitorStop` for an already-finished monitor dismisses a pending terminal wake, including after its monitor record was pruned. See the usage guide for lifetime and disconnect behavior.

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
