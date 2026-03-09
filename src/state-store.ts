import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// State Store (§6 — Lightweight state with directory model)
// ---------------------------------------------------------------------------

/**
 * Persisted state shape (§6.3).
 *
 * Kept minimal for easy migration — just copy the STATE_DIR.
 */
export interface PersistedState {
  /** Per-conversation last processed message timestamp */
  cursors: Record<string, string>;

  /** SMTP consecutive failure count (§9.3 unhealthy threshold) */
  smtp_consecutive_failures: number;

  /** ISO timestamp of last successfully processed event */
  last_event_processed_at: string | null;

  /** ISO timestamp of last successfully sent email */
  last_email_sent_at: string | null;

  /** ISO timestamp of last completed poll round */
  last_poll_completed_at: string | null;

  /** ISO timestamp of last successful persist */
  saved_at: string;
}

/** In-memory dedup entry with expiry tracking */
interface DedupEntry {
  key: string; // channel_id:ts
  addedAt: number;
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5-minute dedup window
const STATE_FILENAME = "state.json";

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  private state: PersistedState;
  private readonly dir: string;
  private readonly filePath: string;

  /** In-memory dedup cache — NOT persisted (§6.3: "短期去重缓存可放内存") */
  private dedupCache: DedupEntry[] = [];

  constructor(stateDir: string) {
    this.dir = stateDir;
    this.filePath = join(stateDir, STATE_FILENAME);
    this.state = this.load();
  }

  // -------------------------------------------------------------------------
  // Cursor management
  // -------------------------------------------------------------------------

  /** Get cursor for a conversation (undefined = no prior history) */
  getCursor(channelId: string): string | undefined {
    return this.state.cursors[channelId];
  }

  /** Update cursor for a conversation */
  setCursor(channelId: string, ts: string): void {
    this.state.cursors[channelId] = ts;
  }

  /** Remove cursors for conversations no longer tracked */
  pruneConversations(activeIds: Set<string>): void {
    for (const id of Object.keys(this.state.cursors)) {
      if (!activeIds.has(id)) {
        delete this.state.cursors[id];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dedup (in-memory only)
  // -------------------------------------------------------------------------

  /** Check if a message ts has already been processed recently */
  isProcessed(channelId: string, ts: string): boolean {
    const key = `${channelId}:${ts}`;
    this.pruneDedup();
    return this.dedupCache.some((e) => e.key === key);
  }

  /** Mark a message ts as processed */
  markProcessed(channelId: string, ts: string): void {
    if (!this.isProcessed(channelId, ts)) {
      this.dedupCache.push({ key: `${channelId}:${ts}`, addedAt: Date.now() });
    }
  }

  /** Remove expired dedup entries */
  private pruneDedup(): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    this.dedupCache = this.dedupCache.filter((e) => e.addedAt > cutoff);
  }

  // -------------------------------------------------------------------------
  // Runtime health state (persisted to disk per §6.3)
  // -------------------------------------------------------------------------

  get smtpConsecutiveFailures(): number {
    return this.state.smtp_consecutive_failures;
  }

  set smtpConsecutiveFailures(count: number) {
    this.state.smtp_consecutive_failures = count;
  }

  get lastEventProcessedAt(): string | null {
    return this.state.last_event_processed_at;
  }

  recordEventProcessed(): void {
    this.state.last_event_processed_at = new Date().toISOString();
  }

  get lastEmailSentAt(): string | null {
    return this.state.last_email_sent_at;
  }

  recordEmailSent(): void {
    this.state.last_email_sent_at = new Date().toISOString();
  }

  get lastPollCompletedAt(): string | null {
    return this.state.last_poll_completed_at;
  }

  recordPollCompleted(): void {
    this.state.last_poll_completed_at = new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Persistence (§6.3, §6.4)
  // -------------------------------------------------------------------------

  /**
   * Persist state to disk atomically (write tmp → rename).
   * Returns true on success, false on failure.
   *
   * §9.3: Persistence failure = potential unhealthy condition.
   */
  persist(): boolean {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }

      this.state.saved_at = new Date().toISOString();

      const tmp = this.filePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      console.error(
        "[state-store] Failed to persist state:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /** Get a readonly snapshot of current persisted state */
  snapshot(): Readonly<PersistedState> {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Private — load / validate / fresh
  // -------------------------------------------------------------------------

  private load(): PersistedState {
    if (!existsSync(this.filePath)) {
      // §6.2: First deploy — start from now, no backfill
      console.log("[state-store] No state file found — first-time startup");
      return this.freshState();
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return this.validate(parsed);
    } catch (err) {
      // §6.4: Corrupt state — start fresh from current moment
      console.warn(
        `[state-store] Failed to load ${this.filePath}, starting fresh:`,
        err instanceof Error ? err.message : err,
      );
      return this.freshState();
    }
  }

  private validate(data: unknown): PersistedState {
    if (
      typeof data !== "object" ||
      data === null ||
      !("cursors" in data) ||
      typeof (data as Record<string, unknown>).cursors !== "object"
    ) {
      throw new Error("Invalid state file structure");
    }

    const obj = data as Record<string, unknown>;
    return {
      cursors: (obj.cursors ?? {}) as Record<string, string>,
      smtp_consecutive_failures:
        typeof obj.smtp_consecutive_failures === "number"
          ? obj.smtp_consecutive_failures
          : 0,
      last_event_processed_at:
        typeof obj.last_event_processed_at === "string"
          ? obj.last_event_processed_at
          : null,
      last_email_sent_at:
        typeof obj.last_email_sent_at === "string"
          ? obj.last_email_sent_at
          : null,
      last_poll_completed_at:
        typeof obj.last_poll_completed_at === "string"
          ? obj.last_poll_completed_at
          : null,
      saved_at:
        typeof obj.saved_at === "string"
          ? obj.saved_at
          : new Date().toISOString(),
    };
  }

  private freshState(): PersistedState {
    return {
      cursors: {},
      smtp_consecutive_failures: 0,
      last_event_processed_at: null,
      last_email_sent_at: null,
      last_poll_completed_at: null,
      saved_at: new Date().toISOString(),
    };
  }
}
