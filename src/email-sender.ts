import { createTransport, type Transporter } from "nodemailer";

import type { AppConfig } from "./config.js";
import type { StateStore } from "./state-store.js";

// ---------------------------------------------------------------------------
// Email Sender (§8, §10.2 — nodemailer SMTP to QQ Mail)
// ---------------------------------------------------------------------------

/** §10.2: Exponential backoff retry delays */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** SMTP timeouts */
const SEND_TIMEOUT_MS = 30_000;

export class EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly to: string;
  private readonly stateStore: StateStore;

  /** §10.2: Daily limit hit — pause sending until next day */
  private dailyLimitPausedUntil = 0;

  constructor(config: AppConfig, stateStore: StateStore) {
    this.from = config.SMTP_USER;
    this.to = config.EMAIL_TO;
    this.stateStore = stateStore;

    this.transporter = createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: true, // SSL for port 465
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send an email with retry + exponential backoff (§10.2).
   * Returns true if sent successfully, false if all retries exhausted.
   *
   * On success: resets consecutive failure count in state store.
   * On failure: increments consecutive failure count.
   */
  async send(subject: string, body: string): Promise<boolean> {
    // Check daily limit pause
    if (this.isDailyLimitPaused()) {
      console.warn("[email] Daily send limit paused — skipping");
      return false;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.transporter.sendMail({
          from: this.from,
          to: this.to,
          subject,
          text: body,
        });

        // Success — reset failure count, record timestamp
        this.stateStore.smtpConsecutiveFailures = 0;
        this.stateStore.recordEmailSent();
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[email] Send failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${errMsg}`,
        );

        // §10.2: Auth failure (535) — don't retry, increment and bail
        if (errMsg.includes("535") || errMsg.includes("Authentication")) {
          console.error(
            "[email] Authentication failure — check SMTP_PASS (授权码)",
          );
          this.recordFailure();
          return false;
        }

        // §10.2: Daily limit (554) — pause until next day
        if (errMsg.includes("554")) {
          console.error(
            "[email] Daily send limit reached — pausing until next day",
          );
          this.pauseForDailyLimit();
          this.recordFailure();
          return false;
        }

        // §10.2: Exponential backoff retry for transient errors
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MS[attempt] ?? 45_000;
          console.log(`[email] Retrying in ${delay / 1000}s...`);
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    this.recordFailure();
    return false;
  }

  /** Verify SMTP connection (used at startup) */
  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      console.log("[email] SMTP connection verified");
      return true;
    } catch (err) {
      console.error(
        "[email] SMTP verification failed:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /** Check if sending is paused due to daily limit */
  isDailyLimitPaused(): boolean {
    return Date.now() < this.dailyLimitPausedUntil;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private recordFailure(): void {
    this.stateStore.smtpConsecutiveFailures += 1;
  }

  /**
   * Pause sending until the start of the next day (midnight UTC+8).
   * QQ Mail daily limits reset at midnight Beijing time.
   */
  private pauseForDailyLimit(): void {
    const now = new Date();
    // Next midnight UTC+8
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(16, 0, 0, 0); // 00:00 UTC+8 = 16:00 UTC
    if (tomorrow.getTime() <= now.getTime()) {
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    }
    this.dailyLimitPausedUntil = tomorrow.getTime();
    console.log(
      `[email] Sending paused until ${tomorrow.toISOString()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
