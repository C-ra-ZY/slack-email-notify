import type { SlackClient } from "./slack-client.js";
import type { StateStore } from "./state-store.js";
import type {
  ConversationDiscovery,
  ConversationInfo,
} from "./conversation-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackMessage {
  ts: string;
  text: string;
  user: string | undefined;
  channel: string;
  channelType: string;
  subtype: string | undefined;
  threadTs: string | undefined;
  /** Team ID for building deep links */
  teamId: string;
}

// ---------------------------------------------------------------------------
// Poller (§4.3, §5.2 — Tiered polling with User-Token-First correctness)
// ---------------------------------------------------------------------------

/**
 * §5.2 Tiered polling schedule:
 *  - DM / MPIM: every 30s
 *  - Active channels (activity in last 2h): every 60s
 *  - Inactive channels: every 10min
 *
 * §5.3 Rate control:
 *  - Handled by SlackClient's rate controller (12/20 req/min)
 *  - On consecutive rate limits, auto-degrade to longer intervals
 */

const POLL_INTERVAL_DM_MS = 30_000; // §5.2: DM/MPIM every 30s
const POLL_INTERVAL_ACTIVE_MS = 60_000; // §5.2: Active channels every 60s
const POLL_INTERVAL_INACTIVE_MS = 10 * 60_000; // §5.2: Inactive every 10min

const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours = "active"
const HISTORY_LIMIT = 100; // §5.4: conservative per-request limit
const TICK_INTERVAL_MS = 5_000; // Check every 5s which conversations are due

/** Multiplier applied when rate-limited to back off polling */
const RATE_LIMIT_DEGRADATION = 3;

export class Poller {
  private readonly slack: SlackClient;
  private readonly stateStore: StateStore;
  private readonly discovery: ConversationDiscovery;

  private teamId = "";
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Mutex to prevent concurrent pollDueConversations runs (Fix 8a) */
  private polling = false;

  /** Per-channel lock to prevent concurrent polling of the same conversation (Review P1 #1) */
  private channelLocks = new Set<string>();

  /** Track when each conversation was last polled */
  private lastPolledAt = new Map<string, number>();

  /** Track which conversations recently had new messages (for tiered scheduling) */
  private lastActivityAt = new Map<string, number>();

  /** Callback when new messages are discovered */
  onMessages: ((messages: SlackMessage[]) => Promise<string | null>) | null = null;

  /** Callback when user token is detected as invalid */
  onTokenInvalid: (() => void) | null = null;

  constructor(
    slack: SlackClient,
    stateStore: StateStore,
    discovery: ConversationDiscovery,
  ) {
    this.slack = slack;
    this.stateStore = stateStore;
    this.discovery = discovery;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the poller. Authenticates, discovers conversations, then begins polling.
   * Returns metadata (selfUserId) after auth + discovery but BEFORE first poll round,
   * so callers can mark health as connected early (Fix 4).
   */
  async start(): Promise<{ selfUserId: string }> {
    this.running = true;

    // Authenticate and get team ID + user ID
    const auth = await this.slack.call((c) => c.auth.test());
    if (!auth.ok || !auth.team_id || !auth.user_id) {
      throw new Error("Slack auth.test failed — check SLACK_USER_TOKEN");
    }
    this.teamId = auth.team_id;
    const selfUserId = auth.user_id;
    console.log(`[poller] Authenticated as user ${selfUserId} in team ${this.teamId}`);

    // Discover conversations
    await this.discovery.refresh();
    this.discovery.startPeriodicRefresh();

    // Initialize lastActivityAt from conversation metadata
    for (const conv of this.discovery.getConversations()) {
      if (conv.lastActivityTs) {
        const tsNum = parseFloat(conv.lastActivityTs);
        if (!isNaN(tsNum)) {
          // Slack epoch timestamps can be seconds or already in milliseconds
          const ms = tsNum > 1e12 ? tsNum : tsNum * 1000;
          this.lastActivityAt.set(conv.id, ms);
        }
      }
    }

    // Do one immediate full poll round (non-blocking for health status)
    void this.pollDueConversations(true).catch((err) => {
      console.error(
        "[poller] Initial poll round error:",
        err instanceof Error ? err.message : err,
      );
    });

    // Start the tick-based scheduler
    this.tickTimer = setInterval(() => {
      void this.pollDueConversations(false).catch((err) => {
        console.error(
          "[poller] Tick error:",
          err instanceof Error ? err.message : err,
        );
      });
    }, TICK_INTERVAL_MS);

    return { selfUserId };
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.discovery.stop();
  }

  /**
   * §4.4: Trigger an incremental sync on a specific conversation.
   * Used by Socket Mode acceleration to reduce latency.
   */
  async syncConversation(channelId: string): Promise<void> {
    // Review P1 #1: Acquire per-channel lock to prevent concurrent
    // polling of the same conversation from tick-based scheduler.
    if (this.channelLocks.has(channelId)) return;

    const conversations = this.discovery.getConversations();
    const conv = conversations.find((c) => c.id === channelId);
    if (!conv) {
      // Might be a new conversation not yet discovered — force refresh
      await this.discovery.refresh();
      const refreshed = this.discovery
        .getConversations()
        .find((c) => c.id === channelId);
      if (refreshed) {
        await this.pollConversation(refreshed);
      }
      return;
    }
    await this.pollConversation(conv);
  }

  // -------------------------------------------------------------------------
  // Tick-based tiered scheduler
  // -------------------------------------------------------------------------

  private async pollDueConversations(forceAll: boolean): Promise<void> {
    if (!this.running) return;

    // Fix 8a: Prevent concurrent poll rounds. If a previous round
    // (e.g. forceAll bootstrap) is still running, skip this tick.
    if (this.polling) return;
    this.polling = true;

    try {
      const conversations = this.discovery.getConversations();
      const now = Date.now();
      const degraded = this.slack.consecutiveRateLimits > 0;
      const degradationMultiplier = degraded ? RATE_LIMIT_DEGRADATION : 1;

      for (const conv of conversations) {
        if (!this.running) break;

        // Check if we're soft-limited — if so, skip non-DM conversations
        if (this.slack.isSoftLimited() && conv.type !== "im" && conv.type !== "mpim") {
          continue;
        }

        const interval = this.getInterval(conv) * degradationMultiplier;
        const lastPolled = this.lastPolledAt.get(conv.id) ?? 0;

        if (forceAll || now - lastPolled >= interval) {
          await this.pollConversation(conv);
        }
      }

      // Persist state after each poll round (§6.3)
      this.stateStore.recordPollCompleted();
      this.stateStore.persist();
    } finally {
      this.polling = false;
    }
  }

  private getInterval(conv: ConversationInfo): number {
    // §5.2: DM / MPIM → 30s
    if (conv.type === "im" || conv.type === "mpim") {
      return POLL_INTERVAL_DM_MS;
    }

    // §5.2: Active channels (activity in last 2h) → 60s
    const lastActivity = this.lastActivityAt.get(conv.id) ?? 0;
    if (Date.now() - lastActivity < ACTIVE_WINDOW_MS) {
      return POLL_INTERVAL_ACTIVE_MS;
    }

    // §5.2: Inactive channels → 10min
    return POLL_INTERVAL_INACTIVE_MS;
  }

  // -------------------------------------------------------------------------
  // Per-conversation polling (§4.3, §5.4)
  // -------------------------------------------------------------------------

  /**
   * §6.2: First-time bootstrap for a conversation.
   * Fetch the single most recent message to establish a cursor.
   * No messages are processed — we start notifying from "now".
   */
  private async bootstrapConversation(conv: ConversationInfo): Promise<void> {
    try {
      const result = await this.slack.call((client) => {
        return client.conversations.history(
          { channel: conv.id, limit: 1 } as Parameters<
            typeof client.conversations.history
          >[0],
        );
      });

      const latestTs = result.messages?.[0]?.ts;
      if (latestTs) {
        this.stateStore.setCursor(conv.id, latestTs);
        console.log(
          `[poller] Bootstrap ${conv.id}: cursor set to ${latestTs}`,
        );
      } else {
        // Empty conversation — set a sentinel cursor so we don't re-bootstrap
        this.stateStore.setCursor(conv.id, "0");
        console.log(
          `[poller] Bootstrap ${conv.id}: empty conversation, cursor set to 0`,
        );
      }
    } catch (err: unknown) {
      if (isTokenInvalidError(err)) {
        console.error(
          "[poller] SLACK_USER_TOKEN appears invalid or revoked",
        );
        this.onTokenInvalid?.();
        return;
      }

      // Fix 8b: Permanent errors (channel_not_found, etc.) — set sentinel
      // cursor so we don't retry this conversation every tick.
      if (isPermanentConversationError(err)) {
        this.stateStore.setCursor(conv.id, "0");
        console.warn(
          `[poller] Bootstrap ${conv.id}: permanent error, marking as skipped:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      console.error(
        `[poller] Bootstrap failed for ${conv.id}:`,
        err instanceof Error ? err.message : err,
      );
      // Don't set cursor — will retry next tick
    }

    this.lastPolledAt.set(conv.id, Date.now());
  }
  private async pollConversation(conv: ConversationInfo): Promise<void> {
    // Review P1 #1: Per-channel lock — only one poll at a time per conversation
    if (this.channelLocks.has(conv.id)) return;
    this.channelLocks.add(conv.id);

    try {
      const oldest = this.stateStore.getCursor(conv.id);

      // §6.2: First-time bootstrap — no cursor means no prior history.
      // Fetch limit=1 to get the latest ts, set as cursor, don't process.
      if (oldest === undefined) {
        await this.bootstrapConversation(conv);
        return;
      }

      const allMessages: SlackMessage[] = [];
      try {
        let cursor: string | undefined;

        // §5.4: Paginate until the full increment window is consumed
        do {
          const result = await this.slack.call((client) => {
            const args: Record<string, unknown> = {
              channel: conv.id,
              limit: HISTORY_LIMIT,
              inclusive: false,
            };
            if (oldest && !cursor) args.oldest = oldest;
            if (cursor) args.cursor = cursor;
            return client.conversations.history(
              args as unknown as Parameters<
                typeof client.conversations.history
              >[0],
            );
          });

          if (result.messages && result.messages.length > 0) {
            // Messages come newest-first; collect all then reverse
            for (const msg of result.messages) {
              if (!msg.ts) continue;

              allMessages.push({
                ts: msg.ts,
                text: msg.text ?? "",
                user: msg.user,
                channel: conv.id,
                channelType: conv.type,
                subtype: msg.subtype,
                threadTs:
                  typeof (msg as Record<string, unknown>).thread_ts === "string"
                    ? ((msg as Record<string, unknown>).thread_ts as string)
                    : undefined,
                teamId: this.teamId,
              });
            }
          }

          cursor =
            result.has_more && result.response_metadata?.next_cursor
              ? result.response_metadata.next_cursor
              : undefined;
        } while (cursor);
      } catch (err: unknown) {
        if (isTokenInvalidError(err)) {
          console.error(
            "[poller] SLACK_USER_TOKEN appears invalid or revoked",
          );
          this.onTokenInvalid?.();
          return;
        }

        // Fix 8b: Permanent errors in regular poll path too
        if (isPermanentConversationError(err)) {
          console.warn(
            `[poller] Conversation ${conv.id} permanently inaccessible, suppressing retries:`,
            err instanceof Error ? err.message : err,
          );
          // Set lastPolledAt far in the future to stop retrying
          this.lastPolledAt.set(conv.id, Date.now() + 24 * 60 * 60 * 1000);
          return;
        }

        console.error(
          `[poller] Error fetching history for ${conv.id}:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      this.lastPolledAt.set(conv.id, Date.now());

      if (allMessages.length === 0) return;

      // Reverse to chronological order
      allMessages.reverse();

      // Filter: skip already-processed (dedup with Socket Mode)
      const newMessages: SlackMessage[] = [];
      for (const msg of allMessages) {
        if (this.stateStore.isProcessed(conv.id, msg.ts)) continue;
        newMessages.push(msg);
      }

      if (newMessages.length > 0) {
        // Track activity for tiered scheduling
        this.lastActivityAt.set(conv.id, Date.now());

        if (this.onMessages) {
          // Callback returns the ts of the last successfully processed message
          const lastSuccessTs = await this.onMessages(newMessages);

          // Only advance cursor to the last successfully processed message
          if (lastSuccessTs) {
            this.stateStore.setCursor(conv.id, lastSuccessTs);
          }
          return;
        }
      }

      // No new messages, but advance cursor to latest fetched ts
      // so we don't re-fetch the same batch next time
      const latestTs = allMessages[allMessages.length - 1]?.ts;
      if (latestTs) {
        this.stateStore.setCursor(conv.id, latestTs);
      }
    } finally {
      this.channelLocks.delete(conv.id);
    }
  }
}
// ---------------------------------------------------------------------------
// Error detection helpers
// ---------------------------------------------------------------------------

function isTokenInvalidError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;

  // @slack/web-api throws with `data.error` for API errors
  if (obj.code === "slack_webapi_platform_error") {
    const data = obj.data as Record<string, unknown> | undefined;
    if (data) {
      const error = data.error;
      return (
        error === "token_revoked" ||
        error === "token_expired" ||
        error === "invalid_auth" ||
        error === "not_authed" ||
        error === "account_inactive"
      );
    }
  }

  return false;
}

/**
 * Fix 8b: Detect permanent conversation errors that will never succeed.
 * These should not be retried — set a sentinel cursor instead.
 */
function isPermanentConversationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;

  if (obj.code === "slack_webapi_platform_error") {
    const data = obj.data as Record<string, unknown> | undefined;
    if (data) {
      const error = data.error;
      return (
        error === "channel_not_found" ||
        error === "is_archived" ||
        error === "not_in_channel" ||
        error === "missing_scope"
      );
    }
  }

  return false;
}
