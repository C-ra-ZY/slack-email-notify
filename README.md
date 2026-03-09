# china-notify
Slack → Email notification relay for users in mainland China

Slack push notifications are unreliable in mainland China. This relay polls Slack conversations with a User Token, matches DMs and @mentions, and forwards each as an individual email via QQ Mail SMTP. QQ邮箱 push via 统一推送联盟 is much more dependable.

## Architecture

```text
Slack API (User Token polling)
  → relay (Node.js 22, runs on homelab)
    → rule matching (DM / @user / @usergroup)
      → QQ Mail SMTP
        → QQ邮箱 App push notification
```

- Polling is the correctness layer and always runs
- Socket Mode is optional acceleration, triggers incremental sync, polling remains source of truth
- Dedup by `channel_id + ts`

## What gets notified

- DMs: 1:1 and multi-party (`im` and `mpim`)
- `@your-user` mentions in any visible channel
- `@your-usergroup` mentions
- Thread replies with @user or @group → notify, pure thread replies → no notify
- Bot messages filtered out
- Message edits: configurable (`notifyEdits`), default off. Deletions: never notify.

## Prerequisites

### Node.js or Docker

Node.js >= 22 or Docker (recommended for homelab)

### Slack User Token (`xoxp-`)

Required scopes:

```text
users:read
channels:read
groups:read
mpim:read
im:read
channels:history
groups:history
mpim:history
im:history
```

### QQ Mail sender account

A separate QQ account as SMTP sender. Enable SMTP and generate 授权码:

```text
QQ邮箱 → 设置 → 账户 → POP3/SMTP → 开启 → 生成授权码
```

SMTP config: `smtp.qq.com:465` SSL

### External monitoring (recommended)

Healthchecks.io or Uptime Kuma URL for `HEALTHCHECK_PING_URL`

## Quick Start (Docker)

```bash
git clone <repo> && cd china-notify
cp .env.example .env
# Edit .env with your tokens and rules
docker compose up -d --build
```

## Quick Start (Node.js)

```bash
npm install
npm run build
cp .env.example .env
# Edit .env
npm start
```

Dev: `npm run dev`

## Configuration

### `.env`

Reference `.env.example`. Key variables:

- `SLACK_USER_TOKEN` - required, User Token for polling
- `SLACK_APP_TOKEN` - optional, for Socket Mode acceleration
- `ENABLE_SOCKET_MODE` - optional, `true`/`false` (default `false`)
- `SMTP_HOST` - default `smtp.qq.com`
- `SMTP_PORT` - default `465`
- `SMTP_USER` - required, sender email
- `SMTP_PASS` - required, sender app password / 授权码
- `EMAIL_TO` - required, recipient email
- `HEALTHCHECK_PING_URL` - optional, external heartbeat URL
- `HEALTH_PORT` - default `8080`
- `RULES_DIRECT_MESSAGES` - `true`/`false`, default `true`
- `RULES_USER_IDS` - comma-separated Slack User IDs to watch for @mentions
- `RULES_GROUP_IDS` - comma-separated Slack Usergroup IDs to watch for @group mentions
- `RULES_NOTIFY_EDITS` - `true`/`false`, default `false`
- `LOG_LEVEL` - `debug`/`info`/`warn`/`error`, default `info`
- `STATE_DIR` - default `data/state` (directory, not a file)

## Finding your Slack IDs

- User ID: Profile → Copy member ID
- User Group ID: mention tokens look like `<!subteam^S0123456789>`, copy the `S...` part

## Polling Strategy

Tiered scheduling:

- DM / MPIM: every 30s
- Active channels (activity within 2h): every 60s
- Inactive channels: every 10min
- Conversation list refresh: every 10min

Rate limits: soft 12 req/min, hard 20 req/min. Respects Slack `429 Retry-After`. Auto-degrades on sustained rate limiting.

## Monitoring

### `/health` endpoint

```json
{
  "status": "healthy",
  "slack_status": "polling_only",
  "smtp_status": "ok",
  "smtp_consecutive_failures": 0,
  "last_event_processed_at": "2026-03-08T12:00:00.000Z",
  "last_email_sent_at": "2026-03-08T12:00:00.000Z",
  "last_poll_completed_at": "2026-03-08T12:00:05.000Z",
  "uptime_seconds": 3600
}
```

- Returns HTTP 200 when healthy/degraded, 503 when unhealthy
- `slack_status`: `connected` (socket mode active), `polling_only`, `disconnected`
- `smtp_status`: `ok`, `failing`, `daily_limit_paused`

### Health states

- `healthy`: Slack polling works, SMTP works, failures < 5
- `degraded`: Temporary issues (rate limiting, short SMTP failures, Slack disconnected)
- `unhealthy`: SMTP failed 5+ times consecutively, OR User Token invalidated, OR state persistence failed

### External heartbeat

Set `HEALTHCHECK_PING_URL`. Relay pings every 5 minutes ONLY when `healthy`. Degraded and unhealthy both stop pinging, triggers external alert. This is the primary "relay is down" alert mechanism.

### Startup email

Sends `[Slack Relay] Started` email on every start/restart.

## Deployment

1. Build the Docker image locally:

```bash
docker build -t china-notify-relay:latest .
```

2. Save, transfer and load on the target server:

```bash
docker save -o china-notify-relay-image.tar china-notify-relay:latest
scp china-notify-relay-image.tar user@server:/path/to/app/
ssh user@server 'docker load -i /path/to/app/china-notify-relay-image.tar'
```

3. Start services on the remote:

```bash
ssh user@server 'cd /path/to/app && docker compose up -d'
```

A `deploy.sh` helper script is included but gitignored — customize it with your own host, user, and paths.

## Migration

To move to another server, copy:

- `.env`
- `data/state/` directory (optional but recommended)

Without the state directory, relay starts fresh from current moment (no backfill). With it, resumes from saved cursors.

## Troubleshooting

- SMTP auth failure (535): QQ 授权码 wrong or SMTP not enabled
- Daily limit (554): QQ Mail limits ~100 emails/day for new accounts
- Rate limiting: relay auto-respects `Retry-After` and degrades polling frequency
- No notifications: check `RULES_*` env vars, check User Token scopes, check `/health`
- Token invalidated: `/health` shows `unhealthy`, re-create token and restart
