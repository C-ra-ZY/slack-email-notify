import { WebClient } from "@slack/web-api";

// ---------------------------------------------------------------------------
// Slack Client — shared WebClient with rate controller (§5.3)
// ---------------------------------------------------------------------------

/**
 * Rate limits (§5.3):
 *  - Soft limit: 12 req/min — normal operating range
 *  - Hard limit: 20 req/min — absolute max before forced wait
 *  - On 429: respect Retry-After exactly
 *  - On consecutive 429s: auto-degrade polling frequency
 */

const SOFT_LIMIT = 12; // requests per minute
const HARD_LIMIT = 20; // absolute cap per minute
const WINDOW_MS = 60_000; // 1-minute sliding window
const DEFAULT_RETRY_AFTER_S = 30;

export interface RateControllerStats {
  requestsInWindow: number;
  softLimited: boolean;
  rateLimitedUntil: number | null; // Date.now() timestamp
  consecutiveRateLimits: number;
}

export class SlackClient {
  readonly web: WebClient;
  private readonly requestTimestamps: number[] = [];
  private rateLimitedUntil = 0;
  private _consecutiveRateLimits = 0;

  constructor(userToken: string) {
    // Disable @slack/web-api's built-in retry AND rate-limit handling
    // so our rate controller has sole control over 429 responses.
    this.web = new WebClient(userToken, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  }

  get consecutiveRateLimits(): number {
    return this._consecutiveRateLimits;
  }

  // -------------------------------------------------------------------------
  // Rate-controlled API call wrapper
  // -------------------------------------------------------------------------

  /**
   * Execute a Slack API call through the rate controller.
   *
   * - Waits if we're in a Retry-After window
   * - Waits if we'd exceed hard limit
   * - Tracks request timestamps for soft/hard limit enforcement
   * - Handles 429 responses by reading Retry-After
   */
  async call<T>(fn: (client: WebClient) => Promise<T>): Promise<T> {
    // Wait if we're in a 429 Retry-After cooldown
    await this.waitForRetryAfter();

    // Wait if we'd exceed the hard limit
    await this.waitForHardLimit();

    // Record this request
    this.requestTimestamps.push(Date.now());

    try {
      const result = await fn(this.web);
      this._consecutiveRateLimits = 0;
      return result;
    } catch (err: unknown) {
      if (isRateLimitError(err)) {
        const retryAfter = getRateLimitDelay(err);
        this.rateLimitedUntil = Date.now() + retryAfter * 1000;
        this._consecutiveRateLimits++;

        console.warn(
          `[slack-client] Rate limited (429). Retry-After: ${retryAfter}s. ` +
            `Consecutive: ${this._consecutiveRateLimits}`,
        );

        // Wait then retry through our own rate controller (not raw fn)
        await sleep(retryAfter * 1000);
        return this.call(fn);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Rate controller queries
  // -------------------------------------------------------------------------

  /** Check if we're currently above the soft limit */
  isSoftLimited(): boolean {
    this.pruneOldTimestamps();
    return this.requestTimestamps.length >= SOFT_LIMIT;
  }

  /** Get rate controller stats for diagnostics */
  getStats(): RateControllerStats {
    this.pruneOldTimestamps();
    return {
      requestsInWindow: this.requestTimestamps.length,
      softLimited: this.requestTimestamps.length >= SOFT_LIMIT,
      rateLimitedUntil:
        this.rateLimitedUntil > Date.now() ? this.rateLimitedUntil : null,
      consecutiveRateLimits: this._consecutiveRateLimits,
    };
  }

  // -------------------------------------------------------------------------
  // Internal rate control
  // -------------------------------------------------------------------------

  private async waitForRetryAfter(): Promise<void> {
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      const waitMs = this.rateLimitedUntil - now;
      console.log(
        `[slack-client] Waiting ${Math.ceil(waitMs / 1000)}s for Retry-After cooldown`,
      );
      await sleep(waitMs);
    }
  }

  private async waitForHardLimit(): Promise<void> {
    this.pruneOldTimestamps();

    if (this.requestTimestamps.length >= HARD_LIMIT) {
      // Wait until the oldest request in the window falls off
      const oldest = this.requestTimestamps[0];
      if (oldest !== undefined) {
        const waitMs = oldest + WINDOW_MS - Date.now() + 100; // +100ms buffer
        if (waitMs > 0) {
          console.log(
            `[slack-client] Hard limit reached (${HARD_LIMIT}/min). Waiting ${Math.ceil(waitMs / 1000)}s`,
          );
          await sleep(waitMs);
          this.pruneOldTimestamps();
        }
      }
    }
  }

  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (
      this.requestTimestamps.length > 0 &&
      this.requestTimestamps[0] !== undefined &&
      this.requestTimestamps[0] < cutoff
    ) {
      this.requestTimestamps.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Record<string, unknown>).code ===
      "slack_webapi_rate_limited_error"
  );
}

function getRateLimitDelay(err: unknown): number {
  if (
    typeof err === "object" &&
    err !== null &&
    "retryAfter" in err &&
    typeof (err as Record<string, unknown>).retryAfter === "number"
  ) {
    return (err as Record<string, unknown>).retryAfter as number;
  }
  return DEFAULT_RETRY_AFTER_S;
}
