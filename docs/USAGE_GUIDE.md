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

## Read-only loops

Set `readOnly: true` on `LoopCreate` for observation work that must not change the project. Read-only wakes require `@abhishek944/pi-ask` 0.2.0 or newer to be installed and loaded. Pi Ask's shared guard keeps only approved read and listing tools active, blocks every other tool call immediately before execution, and restores the previous tools after the complete agent run settles.

A dynamic read-only wake may call `LoopUpdate` only with its own loop ID. It cannot update another loop. Image generation, shell commands, file changes, monitor mutation, and unknown extension tools are unavailable. This is a Pi tool guard, not an operating-system sandbox.

Creation fails if the guard is unavailable. If a persisted read-only loop later fires without an available guard, the wake is not delivered and the loop is paused.

## Managing loops

```text
LoopList
LoopDelete id="1" action="pause"
LoopDelete id="1"
```

`/loop` also provides an interactive create, inspect, pause, resume, and delete menu.

## BTW-style monitor overlay

Run `/monitors` in interactive TUI mode to inspect all loops and background monitors without adding anything to the conversation. The top-centered overlay leaves the main chat visible behind it, refreshes once per second, and does not replace the main editor.

- `Up`/`Down` or `j`/`k`: select
- `Enter` or `Space`: show or hide details
- `p`: pause or resume the selected loop
- `s` twice: stop the selected running monitor
- `d` twice: delete the selected loop
- `r`: refresh now
- `Escape`, `Ctrl+C`, or `q`: close

Commands and buffered output are sanitized and truncated to the available terminal width. Stop and delete require a second key press within four seconds.

## Background monitors

```text
MonitorCreate command="npm run build" description="Run build" onDone="Inspect and fix the result"
MonitorList
MonitorUpdate monitorId="1" current=20 total=100 message="Running"
MonitorStop monitorId="1"
```

The timeout measures inactivity, not total runtime. Output, JSONL `{"progress":{...}}`, and `MonitorUpdate` renew it. `onDone` directly creates a one-shot completion wake. Without `onDone`, a timed monitor still wakes the agent if it becomes inactive and is stopped.

A command may print one JSONL record to report its own outcome: `{"monitorOutcome":{"status":"blocked","message":"Waiting for approval"}}`. The last valid record is retained. `status` is a short label (letters, digits, `_` or `-`, starting with a letter); `message` is optional, up to 1000 characters. The monitor still reports its **process** status (`completed` for exit 0, `error` for nonzero, or `stopped`) and exit code separately. `MonitorList`, completion events, and the `onDone` wake include the command-reported outcome when present; it is untrusted command output, not a monitor-verified result. Ordinary commands need not emit anything.

For example, a monitored shell command can report `blocked` with `printf '%s\n' '{"monitorOutcome":{"status":"blocked","message":"Waiting for approval"}}'`. For Herdr, wrap the invocation so it prints that JSONL record using the status returned by `herdr agent prompt --wait` (such as `blocked` or `done`). Merely running the Herdr CLI does not automatically convert its response into this record. Preserve the Herdr command's exit code in the wrapper when it fails.

### Continuous worker signals

```text
MonitorCreate herdrPaneId="<worker-pane-id>" onSignal="Inspect the worker state and handle blocked or done"
MonitorList
MonitorStop monitorId="<monitor-id>"
```

Use the explicit pane ID returned by Herdr, not an agent name. Do not also pass `command`. This opens one long-lived Herdr socket subscription to `pane.agent_status_changed`, without polling or repeated CLI waits. Confirm the output tail says `Herdr signal subscription ready` before prompting the worker. The same monitor wakes the caller on each subsequent `working`, `blocked`, `idle`, `done`, or `unknown` signal and stays subscribed, even after `done`. Stop it explicitly when the worker is no longer needed. Events before subscription readiness are not replayed.

Herdr signal monitors default to `timeout=0` because a quiet subscription is normal. A disconnect or subscription failure ends the monitor and automatically wakes the caller; `onDone` can override that terminal wake prompt. Signal controllers share the seven-day loop lifetime; an expiry wake tells the caller to recreate the controller if still needed. Monitors still do not survive Pi reload or process recovery.

Ordinary long-lived commands can use `onSignal="..."` too: each valid JSONL `monitorOutcome` record queues a wake without ending the monitor. These wakes are not coalesced, so a later `working` signal does not overwrite a queued `blocked` signal. `onDone` remains separate and one-shot. Signals are untrusted command output, not permission approvals or verified worker results.

Monitor output is untrusted and only its bounded tail is displayed. Session shutdown and switching stop and reap running processes before rebinding loop state.

### Classifier recovery (opt-in, Herdr only)

Classifier recovery is disabled by default. When enabled, an `idle` or `done` Herdr signal first reads the worker's last 10 terminal lines and asks a Pi classifier whether the worker should continue. A confident `continue` decision prompts the live worker automatically and suppresses that signal's caller wake. Every other decision, low confidence, missing credentials, timeout, ineligible worker, changed session, disabled feature, or prompt failure keeps the existing caller notification unchanged.

The classifier chooses one label:

- `complete`: output shows the assigned task is finished.
- `continue`: output explicitly shows unfinished work with a safe next step.
- `blocked`: work needs input, authorization, credentials, an external prerequisite, or was cancelled.
- `inspect`: evidence is missing, contradictory, scope is unclear, or caller inspection is needed.

Only `continue` can trigger an automatic prompt, and only for a live Pi worker that is still `idle` or `done` with unchanged session identity. Working, blocked, unknown, read-only, expired, paused, manually stopped, or replaced-session work is never auto-continued. The worker is never restarted; a dead process keeps its normal caller notification.

Configure with `/loop settings` or edit `~/.pi/agent/pi-loop-monitor.json`:

```json
{
  "classifierRecovery": {
    "enabled": false,
    "provider": "typesafe",
    "model": "jev-latest",
    "minContinueProbability": 0.8,
    "maxAttempts": 1
  }
}
```

Supported classifiers are Jev (`typesafe/jev-latest`), OpenAI Decisions (`openai/gpt-6-luna`), and Cloudflare Clef/Clef Flash. The provider needs usable Pi credentials. `minContinueProbability` must be 0.8-1. `maxAttempts` (1-10) limits automatic continuations per monitor. Enabling shares the 10-line snippet with the classifier provider and may incur charges; common secrets are redacted, but sensitive text may remain.

## Configuration

- `PI_LOOP_DEBUG`: enables debug logging
- `~/.pi/agent/pi-loop-monitor.json`: optional `classifierRecovery` opt-in above; absent file means disabled

Loops are always scoped to one Pi session. Their state is persisted under `~/.pi/loops/` as `loops-<session-id>.json` and is never shared between sessions. Monitor state remains process-local.
