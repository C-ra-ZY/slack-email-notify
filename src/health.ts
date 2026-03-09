import { createServer, type Server } from "node:http";

import type { AppConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { EmailSender } from "./email-sender.js";
import type { SocketModeAccelerator } from "./socket-mode.js";

// ---------------------------------------------------------------------------
// Health Monitor (§9 — State machine + /health endpoint + external ping)
// ---------------------------------------------------------------------------

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** §9.3: SMTP consecutive failures threshold for unhealthy */
const SMTP_UNHEALTHY_THRESHOLD = 5;

/** §9.4: Heartbeat interval */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Polling liveness staleness thresholds for 5-minute unified sweeps */
const POLL_STALE_DEGRADED_MS = 15 * 60 * 1000; // 15 min without poll → degraded
const POLL_STALE_UNHEALTHY_MS = 30 * 60 * 1000; // 30 min without poll → unhealthy
const POLL_GRACE_PERIOD_MS = 6 * 60 * 1000; // Grace for startup + first sweep

export interface HealthSnapshot {
  status: HealthStatus;
  slack_status: "connected" | "disconnected" | "polling_only";
  smtp_status: "ok" | "failing" | "daily_limit_paused";
  smtp_consecutive_failures: number;
  last_event_processed_at: string | null;
  last_email_sent_at: string | null;
  last_poll_completed_at: string | null;
  uptime_seconds: number;
}

export class HealthMonitor {
  private readonly config: AppConfig;
  private readonly stateStore: StateStore;
  private readonly emailSender: EmailSender;

  private server: Server | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();

  // State tracking
  private slackConnected = false;
  private socketModeRef: SocketModeAccelerator | null = null;
  private tokenInvalid = false;
  private persistenceFailing = false;

  constructor(
    config: AppConfig,
    stateStore: StateStore,
    emailSender: EmailSender,
  ) {
    this.config = config;
    this.stateStore = stateStore;
    this.emailSender = emailSender;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    // Start HTTP health endpoint (§9.2)
    this.startHttpServer();

    // Start heartbeat ping (§9.4)
    this.startHeartbeat();

    // §9.5: Send startup email
    await this.sendStartupEmail();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // -------------------------------------------------------------------------
  // State updates (called by other modules)
  // -------------------------------------------------------------------------

  setSlackConnected(connected: boolean): void {
    this.slackConnected = connected;
  }

  /** Review P2 #3: Store socket mode ref for live connection status */
  setSocketMode(socketMode: SocketModeAccelerator | null): void {
    this.socketModeRef = socketMode;
  }

  /** §9.3: User Token invalidation → unhealthy */
  setTokenInvalid(): void {
    this.tokenInvalid = true;
    console.error("[health] SLACK_USER_TOKEN marked as invalid — unhealthy");
  }

  /** §9.3: State persistence failure → unhealthy */
  setPersistenceFailing(failing: boolean): void {
    this.persistenceFailing = failing;
  }

  // -------------------------------------------------------------------------
  // Health status computation (§9.3 state machine)
  // -------------------------------------------------------------------------

  getStatus(): HealthStatus {
    // §9.3: Unhealthy conditions
    if (this.tokenInvalid) return "unhealthy";
    if (this.persistenceFailing) return "unhealthy";
    if (this.stateStore.smtpConsecutiveFailures >= SMTP_UNHEALTHY_THRESHOLD) {
      return "unhealthy";
    }

    // Review P1 #2: Polling liveness check — detect hung poller
    const pollStaleness = this.getPollStalenessMs();
    if (pollStaleness !== null && pollStaleness >= POLL_STALE_UNHEALTHY_MS) {
      return "unhealthy";
    }

    // §9.3: Degraded conditions
    if (!this.slackConnected) return "degraded";
    if (this.stateStore.smtpConsecutiveFailures > 0) return "degraded";
    if (this.emailSender.isDailyLimitPaused()) return "degraded";
    if (pollStaleness !== null && pollStaleness >= POLL_STALE_DEGRADED_MS) {
      return "degraded";
    }

    return "healthy";
  }

  /**
   * Review P1 #2: Calculate how long since the last poll completed.
   * Returns null during startup grace period (before first poll expected).
   * Returns milliseconds of staleness otherwise.
   */
  private getPollStalenessMs(): number | null {
    const uptime = Date.now() - this.startedAt;
    if (uptime < POLL_GRACE_PERIOD_MS) return null; // Grace period after startup

    const lastPoll = this.stateStore.lastPollCompletedAt;
    if (!lastPoll) {
      // Poller never completed a round — treat as stale for full uptime
      return uptime;
    }

    const lastPollMs = new Date(lastPoll).getTime();
    if (isNaN(lastPollMs)) return uptime;

    return Date.now() - lastPollMs;
  }

  getSnapshot(): HealthSnapshot {
    const status = this.getStatus();
    const smtpFails = this.stateStore.smtpConsecutiveFailures;
    // Review P2 #3: Read live connection status from SocketModeAccelerator
    const socketConnected = this.socketModeRef?.connected ?? false;
    let slackStatus: HealthSnapshot["slack_status"];
    if (this.slackConnected) {
      slackStatus = socketConnected ? "connected" : "polling_only";
    } else {
      slackStatus = "disconnected";
    }

    let smtpStatus: HealthSnapshot["smtp_status"];
    if (this.emailSender.isDailyLimitPaused()) {
      smtpStatus = "daily_limit_paused";
    } else if (smtpFails > 0) {
      smtpStatus = "failing";
    } else {
      smtpStatus = "ok";
    }

    return {
      status,
      slack_status: slackStatus,
      smtp_status: smtpStatus,
      smtp_consecutive_failures: smtpFails,
      last_event_processed_at: this.stateStore.lastEventProcessedAt,
      last_email_sent_at: this.stateStore.lastEmailSentAt,
      last_poll_completed_at: this.stateStore.lastPollCompletedAt,
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  // -------------------------------------------------------------------------
  // HTTP /health endpoint (§9.2)
  // -------------------------------------------------------------------------

  private startHttpServer(): void {
    this.server = createServer((req, res) => {
      if (req.url === "/health" && req.method === "GET") {
        const snapshot = this.getSnapshot();
        const statusCode = snapshot.status === "unhealthy" ? 503 : 200;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snapshot, null, 2));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    this.server.listen(this.config.HEALTH_PORT, () => {
      console.log(
        `[health] HTTP endpoint listening on :${this.config.HEALTH_PORT}/health`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // External heartbeat ping (§9.4)
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    if (!this.config.HEALTHCHECK_PING_URL) {
      console.log(
        "[health] No HEALTHCHECK_PING_URL configured — skipping heartbeat",
      );
      return;
    }

    const ping = async () => {
      const status = this.getStatus();

      // §9.4: "只有在 healthy 状态下才允许上报成功心跳"
      // Degraded and unhealthy both STOP heartbeat → triggers external alert
      if (status !== "healthy") {
        console.warn(
          `[health] Status ${status} — skipping heartbeat ping`,
        );
        return;
      }

      try {
        const url = this.config.HEALTHCHECK_PING_URL!;
        const response = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          console.warn(
            `[health] Heartbeat ping returned ${response.status}`,
          );
        }
      } catch (err) {
        console.warn(
          "[health] Heartbeat ping failed:",
          err instanceof Error ? err.message : err,
        );
      }
    };

    // Initial ping
    void ping();
    this.heartbeatTimer = setInterval(() => void ping(), HEARTBEAT_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Startup email (§9.5)
  // -------------------------------------------------------------------------

  private async sendStartupEmail(): Promise<void> {
    const mode = this.config.ENABLE_SOCKET_MODE
      ? "polling + socket"
      : "polling-only";

    const subject = "[Slack Relay] Started";
    const body = [
      "china-notify relay has started.",
      "",
      `Time: ${new Date().toISOString()}`,
      `Mode: ${mode}`,
      `Health endpoint: http://localhost:${this.config.HEALTH_PORT}/health`,
      "",
      "If you did not expect this restart, check your server logs.",
    ].join("\n");

    const sent = await this.emailSender.send(subject, body);
    if (sent) {
      console.log("[health] Startup email sent");
    } else {
      console.error(
        "[health] Failed to send startup email — SMTP may be misconfigured",
      );
    }
  }
}
