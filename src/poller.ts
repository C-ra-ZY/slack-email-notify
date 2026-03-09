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
// Poller (§4.3, §5.2 — Unified polling with User-Token-First correctness)
// ---------------------------------------------------------------------------

/**
 * §5.2 Unified polling schedule:
 *  - All visible conversations are polled in one sweep every 5 minutes
 *  - No per-type loops for DM / channel / active / inactive
 *
 * §5.3 Rate control:
 *  - Handled by SlackClient's shared rate controller (12/20 req/min)
 *  - Requests are proactively paced to stay near the soft limit
 */

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const HISTORY_LIMIT = 100; // §5.4: conservative per-request limit
const MIN_NEXT_SWEEP_DELAY_MS = 1_000;

export class Poller {
  private readonly slack: SlackClient;
  private readonly stateStore: StateStore;
  private readonly discovery: ConversationDiscovery;

  private teamId = "";
  private running = false;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  /** Mutex to prevent overlapping sweep runs */
  private polling = false;

  /** Per-channel lock to prevent concurrent polling of the same conversation */
  private channelLocks = new Set<string>();

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
   * Start the poller. Authenticates, discovers conversations, then begins the
   * unified polling loop. Returns metadata (selfUserId) after auth + discovery
   * but before the first sweep completes, so callers can mark health early.
   */
  async start(): Promise<{ selfUserId: string }> {
    this.running = true;

    const auth = await this.slack.call((c) => c.auth.test());
    if (!auth.ok || !auth.team_id || !auth.user_id) {
      throw new Error("Slack auth.test failed — check SLACK_USER_TOKEN");
    }
    this.teamId = auth.team_id;
    const selfUserId = auth.user_id;
    console.log(
      `[poller] Authenticated as user ${selfUserId} in team ${this.teamId}`,
    );

    await this.discovery.refresh();
    this.discovery.startPeriodicRefresh();

    void this.runSweepLoop(true).catch((err) => {
      console.error(
        "[poller] Initial sweep error:",
        err instanceof Error ? err.message : err,
      );
    });

    return { selfUserId };
  }

  stop(): void {
    this.running = false;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.discovery.stop();
  }

  /**
   * §4.4: Trigger an incremental sync on a specific conversation.
   * Used by Socket Mode acceleration to reduce latency.
   */
  async syncConversation(channelId: string): Promise<void> {
    if (this.channelLocks.has(channelId)) return;

    const conversations = this.discovery.getConversations();
    const conv = conversations.find((c) => c.id === channelId);
    if (!conv) {
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
  // Unified sweep scheduler
  // -------------------------------------------------------------------------

  private async runSweepLoop(forceAll: boolean): Promise<void> {
    const startedAt = Date.now();

    try {
      await this.pollAllConversations(forceAll);
    } catch (err) {
      console.error(
        "[poller] Sweep error:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      if (!this.running) return;

      const elapsed = Date.now() - startedAt;
      const delay = Math.max(MIN_NEXT_SWEEP_DELAY_MS, POLL_INTERVAL_MS - elapsed);
      this.sweepTimer = setTimeout(() => {
        void this.runSweepLoop(false);
      }, delay);
    }
  }

  private async pollAllConversations(forceAll: boolean): Promise<void> {
    if (!this.running) return;

    if (this.polling) {
      console.warn("[poller] Sweep still running — skipping overlapping trigger");
      return;
    }
    this.polling = true;

    try {
      const conversations = this.discovery.getConversations();
      console.log(
        `[poller] Starting ${forceAll ? "bootstrap " : ""}sweep across ${conversations.length} conversations`,
      );

      for (const conv of conversations) {
        if (!this.running) break;
        await this.pollConversation(conv);
      }

      this.stateStore.recordPollCompleted();
      this.stateStore.persist();
      console.log("[poller] Sweep completed");
    } finally {
      this.polling = false;
    }
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
        this.stateStore.setCursor(conv.id, "0");
        console.log(
          `[poller] Bootstrap ${conv.id}: empty conversation, cursor set to 0`,
        );
      }
    } catch (err: unknown) {
      if (isTokenInvalidError(err)) {
        console.error("[poller] SLACK_USER_TOKEN appears invalid or revoked");
        this.onTokenInvalid?.();
        return;
      }

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
    }
  }

  private async pollConversation(conv: ConversationInfo): Promise<void> {
    if (this.channelLocks.has(conv.id)) return;
    this.channelLocks.add(conv.id);

    try {
      const oldest = this.stateStore.getCursor(conv.id);

      if (oldest === undefined) {
        await this.bootstrapConversation(conv);
        return;
      }

      const allMessages: SlackMessage[] = [];
      try {
        let cursor: string | undefined;

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
              args as unknown as Parameters<typeof client.conversations.history>[0],
            );
          });

          if (result.messages && result.messages.length > 0) {
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
          console.error("[poller] SLACK_USER_TOKEN appears invalid or revoked");
          this.onTokenInvalid?.();
          return;
        }

        if (isPermanentConversationError(err)) {
          console.warn(
            `[poller] Conversation ${conv.id} permanently inaccessible, marking as skipped:`,
            err instanceof Error ? err.message : err,
          );
          this.stateStore.setCursor(conv.id, "0");
          return;
        }

        console.error(
          `[poller] Error fetching history for ${conv.id}:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      if (allMessages.length === 0) return;

      allMessages.reverse();

      const newMessages: SlackMessage[] = [];
      for (const msg of allMessages) {
        if (this.stateStore.isProcessed(conv.id, msg.ts)) continue;
        newMessages.push(msg);
      }

      if (newMessages.length > 0 && this.onMessages) {
        const lastSuccessTs = await this.onMessages(newMessages);

        if (lastSuccessTs) {
          this.stateStore.setCursor(conv.id, lastSuccessTs);
        }
        return;
      }

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
