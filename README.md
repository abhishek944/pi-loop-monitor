# pi-loop-monitor

A private Pi extension that provides only persistent agent wake loops and background command monitors.

This project was adapted from [trvon/pi-loop](https://github.com/trvon/pi-loop) and reduced to the loop and monitor features. It is intentionally not published to npm and does not include workflows, task queues, task RPC, subagent orchestration, or controller routing.

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
MonitorList
MonitorUpdate monitorId="1" current=50 total=100 message="Halfway"
MonitorStop monitorId="1"
/monitors
```

The `/monitors` dashboard uses the same top-centered overlay shape as `pi-btw`, so the main chat remains visible behind it. It refreshes live, shows bounded loop and monitor details, and supports keyboard actions: arrows or `j`/`k` to select, `Enter` to toggle details, `p` to pause or resume a loop, `s` twice to stop a monitor, `d` twice to delete a loop, and `Escape` or `Ctrl+C` to close.

`MonitorCreate.timeout` is an inactivity timeout. Output, JSONL progress, or `MonitorUpdate` renews it. `onDone` creates a direct one-shot loop wake after completion; it does not require another controller subsystem.

Recurring loops expire after seven days. Event and hybrid subscriptions from an earlier session are retired during recovery. Dynamic loops must call `LoopUpdate` once per wake.

## Development

```bash
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
git diff --check
```

See the [usage guide](docs/USAGE_GUIDE.md) and [reference](docs/REFERENCE.md).
