# pi-loop-monitor development guide

This private local Pi extension provides only persistent cron/event/hybrid/dynamic loops and background process monitors.

## Boundaries

- `LoopStore` exclusively owns persisted loop state.
- `MonitorManager` owns process-local monitor state.
- The package has no workflows, orchestration, subagent integration, standalone tasks, backlog processing, task RPC, or controller routing.
- `onDone` is a direct monitor callback backed by an ordinary one-shot loop.
- Pending notifications are memory-only. Persisted loops recover when Pi resumes; monitors do not survive Pi process death.

## Safety

File-backed stores use PID locks, unique temporary snapshots, fsync, atomic rename, directory fsync, previous-snapshot recovery, and visible corruption failure. Session shutdown and switch increment the generation, stop triggers, clear pending notifications, and await monitor shutdown before rebinding. Delayed callbacks must check the current generation/context before mutation.

Use `debug(...)` behind `PI_LOOP_DEBUG`, `textResult(...)` for tool output, and exact TypeBox field names. Keep comments focused on why. Mutations go through reducers and stores.

## Exact public runtime surface

Tools: `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete`, `MonitorCreate`, `MonitorList`, `MonitorUpdate`, `MonitorStop`.

Command: `/loop`.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
git diff --check
```

Limits: 25 loops, 25 running monitors, seven-day recurring-loop lifetime, and a five-minute default monitor inactivity timeout.
