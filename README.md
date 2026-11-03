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
MonitorCreate hcTerminalId="<core-terminal-address>" onSignal="Handle the worker's state change"
MonitorList
MonitorUpdate monitorId="1" current=50 total=100 message="Halfway"
MonitorStop monitorId="1"
/monitors
```

The `/monitors` dashboard uses the same top-centered overlay shape as `pi-btw`, so the main chat remains visible behind it. It refreshes live. Use arrows or `j`/`k` to select, then `Enter` to open a dedicated monitor output window (or toggle loop details). Output wraps and the complete captured command output is scrollable: arrows scroll, `PageUp`/`PageDown` page, `Home` goes to the beginning, and `End` follows live output. `Escape` returns to the overview; another `Escape` closes it. Overview actions remain `p` to pause/resume a loop, `s` twice to stop a monitor, and `d` twice to delete a loop.

Full stdout/stderr capture uses private temporary files with bounded in-memory reads. Logs are removed when the monitor is pruned (15 minutes after termination) or the session shuts down, switches, or reloads. They are not a durable archive. `MonitorList` still shows only a bounded tail. Core subscription monitors show subscription signals, not the worker's full transcript; use its Herdr tab for that.

`MonitorCreate.timeout` is an inactivity timeout. Output, JSONL progress, or `MonitorUpdate` renews it. `onDone` creates a direct one-shot loop wake after completion; it does not require another controller subsystem.

For Core workers, hcTerminalId plus onSignal keeps one monitor subscribed across turns, native program statuses and process lifecycle events. Confirm `Core signal subscription ready` in MonitorList before prompting; stop it explicitly after collecting accepted results. onDone means the subscriber process ended, not worker task completion. Existing latest-state wake coalescing is retained; turn identifiers distinguish repeated outcomes. No old TUI socket or HERDR_ENV is needed. Ordinary commands can still emit JSONL monitorOutcome signals.

Recurring loops expire after seven days. Event and hybrid subscriptions from an earlier session are retired during recovery. Dynamic loops must call `LoopUpdate` once per wake.

Read-only loops use the shared guard provided by [`@abhishek944/pi-ask`](https://github.com/abhishek944/pi-ask) 0.2.0 or newer. Pi Ask must be installed and loaded. The guard removes mutating and unknown tools for the complete agent run, checks every tool call again before execution, and restores the previous tools after Pi fully settles. Dynamic read-only loops may call `LoopUpdate` only for the loop that fired. If the guard is missing, a new read-only loop is rejected and a recovered loop is paused rather than running without enforcement. A temporarily busy guard leaves the wake queued until the current restricted run settles.

Loop state is always scoped to one Pi session and persisted under `~/.pi/loops/` as `loops-<session-id>.json`. Loops are never shared between sessions.

## Display commands

| Command | Display |
| --- | --- |
| `/monitors` | Open the on-demand overlay dashboard |
| `/monitors compact-on` / `/monitors compact-off` | Show/hide the existing compact Pi status line |
| `/monitors herdr-on` / `/monitors herdr-off` | Open/focus or close only this session’s native activity pane |

Visibility changes never stop loops or monitors. The compact and native displays are independent. `/monitors herdr` is replaced by `/monitors herdr-on`.

## Native Herdr activity view

Run `/monitors herdr-on` from the intended Pi session to open a read-only Loops/Monitors pane. Tasks is not required: the first panel opens beside the source terminal and occupies the full panel column. Opening `/works herdr-on` and `/monitors herdr-on` in either order stacks the second panel below the first, with an equal initial split and independent scrolling. Reopening an existing panel focuses it. Neither opens at startup or targets an arbitrary focused pane. Local Herdr sessions and the personal Tasks layout/header (always-visible32px header,8px pane gap) are required. Customized incompatible files are preserved and reported.

The real native header has keyboard-accessible Loops/Monitors tabs (Left/Right/Home/End) and a close button that removes only this view. Enter/Space toggles inline details. Loops show actual waiting/awaiting-update/paused state, prompt and recorded facts. Monitors show only process state, name and elapsed time, with command/process/outcome and latest3 wrapped temporary output lines in details. No monitor numbering, progress, process controls or full-log native transport. `/monitors` without arguments retains its existing interactive Pi overlay/actions/full temporary output.

Pi remains the only scheduler/process/output owner. The native view reads a disposable, bounded session/runtime/terminal-bound display projection (`~/.pi/loops/activity-<session>-<runtime>.json`); output/progress changes coalesce to at most one write per second, and the existing30s heartbeat renews runtime freshness. Missing/error/closed source or65s without renewal freezes live indicators/time and labels last-known data. Projection disposal does not change loop persistence or monitor15min terminal pruning. No daemon, second store, recovery service, action transport or Durable migration is added.

The compact Pi TUI status/footer is **off by default**. Use `/monitors compact-on` or `/monitors compact-off` to change visibility in the running instance without changing settings; `PI_LOOP_MONITOR_TUI_STATUS=1` remains the startup opt-in default. Tools, loops, monitors and `/monitors` continue regardless. Restart/reload Pi after installing the changed extension; the native assets hot-reload. Install the bundled `herdr/pi-loop-monitor` assets and activity-aware `pi-tasks/herdr/pi-tasks/header.js` into the existing personal header clone only after inspecting/backing up differences. Never replace its original `base.js`, shipped layouts or unrelated custom files. New Tasks header clones declare the `pi_activity_header: 1` capability automatically. For an existing personal clone, install the updated adapter and add `"pi_activity_header": 1` to that clone's `mod.json` only after inspecting/backing up differences. Existing activity views from an old runtime should be closed and reopened deliberately.

## Native Durable extension (settings-only)

For Durable 1.1 hosts, import `@abhishek944/pi-loop-monitor/durable` and install
`createLoopMonitorDurableExtension` in a registry before opening a Harness:

```ts
import { createLoopMonitorDurableExtension } from "@abhishek944/pi-loop-monitor/durable";
import { createRegistry } from "@earendil-works/pi-durable";

const registry = createRegistry();
registry.install(createLoopMonitorDurableExtension({
  defaultMonitorTimeoutMs: 300_000,
  maxMonitors: 25,
  maxLoops: 25,
}));
// The host opens its own Harness with its models/storage/env and installs the extension.
```

Settings are numbers only (timeouts, limits, tail bounds) and are validated and
frozen at creation. There are no scheduler, process, auth, storage, or callback
options. Cron/interval parsing reuses the existing `loop-parse` utilities;
`TaskRuntime` conversation handles admit durable wakes, `runtime.sleep` enforces
wake times, document watches observe pause/delete/stop, and `ExecutionEnv.exec`
runs monitor commands where the host provides a Node environment.

Native `LoopCreate` supports cron/interval and idle triggers only; event and
hybrid triggers are rejected with the supported alternatives. There is no
`readOnly` parameter. Native `MonitorCreate` takes a shell command only;
`hcTerminalId`/`onSignal` are rejected as desktop-only. `onDone` is a durable
conversation input. Loops and monitors are conversation-owned background tasks;
paused or deleted loops are terminal and must be recreated explicitly. A
recovered monitor is `unknown`, never `running`; uncertain commands are never
respawned and live tool results are never fabricated.

## Development

```bash
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
git diff --check
```

See the [usage guide](docs/USAGE_GUIDE.md) and [reference](docs/REFERENCE.md).
