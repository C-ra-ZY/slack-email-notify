# Polling And Logging Update

Date: 2026-03-09

## Background

Server-side container logs showed long-running, repeated messages like:

```text
[slack-client] Hard limit reached (20/min). Waiting 1s
```

This was not a startup-only burst. The running relay was continuously hitting its own hard limit during steady-state operation.

After checking the live server:

- the relay was running in `polling-only` mode
- the tracked conversation count was `27`
- the old poller still used tiered scheduling:
  - DM / MPIM every 30 seconds
  - active channels every 60 seconds
  - inactive channels every 10 minutes

In the actual deployment, the DM-like conversation count alone was enough to make the old schedule unsustainable.

## Decision

We changed the runtime model in two ways:

1. Add timestamps to application logs
2. Replace tiered polling with one unified polling loop

The new polling policy is:

- all visible conversations are polled by one shared sweep
- one sweep runs every 5 minutes
- no separate loop for DM / active channel / inactive channel
- Slack API calls are proactively paced near the soft limit instead of waiting until the hard limit is reached

## Code Changes

### 1. Timestamped logging

Added a console wrapper in:

- `src/logging.ts`

Installed at process startup in:

- `src/index.ts`

Effect:

- every `console.log / warn / error / info / debug` line now includes an ISO timestamp
- container logs are readable without relying on Docker's outer timestamp layer

### 2. Unified polling loop

Reworked:

- `src/poller.ts`

Changes:

- removed the tiered interval model
- removed per-type scheduling logic
- added one unified sweep timer
- each sweep processes all discovered conversations sequentially
- next sweep starts 5 minutes after the prior sweep start, with overlap protection

### 3. Proactive Slack API pacing

Updated:

- `src/slack-client.ts`

Changes:

- all Slack API calls now go through a single serialized queue
- requests are proactively spaced to target the soft limit (`12 req/min`)
- hard limit protection (`20 req/min`) is still kept as the final safety cap
- existing `429 Retry-After` handling is retained

Expected behavior after this change:

- normal logs should show `Soft pacing active`
- `Hard limit reached` should become rare or disappear in steady-state

### 4. Health thresholds adjusted

Updated:

- `src/health.ts`

Changes:

- poll staleness thresholds were widened to match 5-minute sweeps
- startup grace period was widened so `/health` does not flap during the first sweep

### 5. Documentation updated

Updated:

- `README.md`
- `REQUIREMENTS.md`

The docs now describe:

- unified 5-minute polling
- proactive pacing near the soft limit
- no more tiered per-type polling schedule

## Deployment

The updated code was built locally and deployed to:

- host: `192.168.31.199`
- container: `china-notify-relay-1`

Deployment path:

- local Docker build
- image tar upload
- remote `docker load`
- remote `docker compose up -d`

## Verification

After deployment, server-side checks showed:

- the new container started successfully
- logs now include application-level ISO timestamps
- `/health` returned `healthy`
- the relay reported `polling-only`
- no new `Hard limit reached` messages were found after restart
- logs showed `Soft pacing active (12/min target)` instead

Example observed log pattern after deployment:

```text
[2026-03-09T10:45:11.400Z] [poller] Starting bootstrap sweep across 27 conversations
[2026-03-09T10:45:11.400Z] [slack-client] Soft pacing active (12/min target). Waiting 5s
```

## Operational Notes

- Notification latency is now intentionally higher than before.
- Expected delivery delay is typically within one polling window.
- The main goal of this change is stability and correctness under Slack API constraints, not minimum latency.

## Current Expected Runtime Pattern

Healthy steady-state should look like:

- one full polling sweep roughly every 5 minutes
- periodic `Soft pacing active` logs during a sweep
- no sustained `Hard limit reached` loop
- `/health` remains `healthy`

If `Hard limit reached` starts appearing continuously again, the next thing to check is:

- actual conversation count growth
- unexpected Socket Mode enablement
- unusually large pagination volume in certain conversations
