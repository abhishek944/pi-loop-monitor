# pi-loop-monitor usage

## Scheduled and event loops

```text
/loop 5m check the deploy
/loop event build:done inspect the result
LoopCreate trigger="0 9 * * 1-5" prompt="Review alerts" maxFires=10
LoopCreate trigger="tool_execution_end" triggerType="event" prompt="Inspect the tool result" recurring=true
```

Intervals are converted to five-field cron expressions. Prefer events when a useful source exists. Hybrid triggers combine a schedule and event with debounce. Use `maxFires` for polling. Recurring loops expire after seven days and must be recreated explicitly when still needed.

## Dynamic loops

Free text passed to `/loop` creates a dynamic loop:

```text
/loop finish the release checklist
LoopUpdate id="1" status="continue" state="Tests pass" nextInterval="5m"
LoopUpdate id="1" status="paused" state="Waiting for credentials"
LoopUpdate id="1" status="completed"
```

Call `LoopUpdate` exactly once after every dynamic wake. Use `continue` while any work remains, `paused` only for a real blocker, and `completed` only when the goal is done.

## Managing loops

```text
LoopList
LoopDelete id="1" action="pause"
LoopDelete id="1"
```

`/loop` also provides an interactive create, inspect, pause, resume, and delete menu.

## Background monitors

```text
MonitorCreate command="npm run build" description="Run build" onDone="Inspect and fix the result"
MonitorList
MonitorUpdate monitorId="1" current=20 total=100 message="Running"
MonitorStop monitorId="1"
```

The timeout measures inactivity, not total runtime. Output, JSONL `{"progress":{...}}`, and `MonitorUpdate` renew it. `onDone` directly creates a one-shot completion wake. Without `onDone`, a timed monitor still wakes the agent if it becomes inactive and is stopped.

Monitor output is untrusted and only its bounded tail is displayed. Session shutdown and switching stop and reap running processes before rebinding loop state.

## Configuration

- `PI_LOOP_SCOPE`: `memory`, `session`, or `project`; default `session`
- `PI_LOOP`: path override or `off`
- `PI_LOOP_DEBUG`: enables debug logging

Session loop files live under `.pi/loops/`. Monitor state is process-local.
