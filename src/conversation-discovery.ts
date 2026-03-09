import type { SlackClient } from "./slack-client.js";

// ---------------------------------------------------------------------------
// Conversation Discovery (§4.2, §5.2 — User-visible conversation enumeration)
// ---------------------------------------------------------------------------

const CONVERSATION_TYPES = "im,mpim,public_channel,private_channel";
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // §5.2: 10 minutes
const PAGE_LIMIT = 200;

export interface ConversationInfo {
  id: string;
  type: "im" | "mpim" | "public_channel" | "private_channel";
  /** Last time this conversation had activity (from Slack's perspective) */
  lastActivityTs: string | null;
}

export class ConversationDiscovery {
  private readonly slack: SlackClient;
  private conversations: ConversationInfo[] = [];
  private updatedAt = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  onRefresh: (() => void) | null = null;

  constructor(slack: SlackClient) {
    this.slack = slack;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Get current list of tracked conversations */
  getConversations(): readonly ConversationInfo[] {
    return this.conversations;
  }

  /** Get a set of all tracked conversation IDs */
  getConversationIds(): Set<string> {
    return new Set(this.conversations.map((c) => c.id));
  }

  /** Force refresh the conversation list (e.g. on startup) */
  async refresh(): Promise<void> {
    await this.doRefresh();
  }

  /** Start periodic refresh (§5.2: every 10 minutes) */
  startPeriodicRefresh(): void {
    if (this.refreshTimer) return;

    this.refreshTimer = setInterval(() => {
      void this.doRefresh().catch((err) => {
        // §10.1: "会话枚举失败 — 保留旧会话集合，稍后重试"
        console.error(
          "[conversation-discovery] Periodic refresh failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }, REFRESH_INTERVAL_MS);
  }

  /** Stop periodic refresh */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Check if the conversation list is stale (hasn't been refreshed in time) */
  isStale(): boolean {
    return Date.now() - this.updatedAt > REFRESH_INTERVAL_MS * 2;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async doRefresh(): Promise<void> {
    console.log("[conversation-discovery] Refreshing conversation list...");
    const conversations: ConversationInfo[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.slack.call((client) => {
        const args: Record<string, unknown> = {
          types: CONVERSATION_TYPES,
          limit: PAGE_LIMIT,
        };
        if (cursor) args.cursor = cursor;
        return client.users.conversations(
          args as Parameters<typeof client.users.conversations>[0],
        );
      });

      if (result.channels) {
        for (const ch of result.channels) {
          if (ch.id) {
            conversations.push({
              id: ch.id,
              type: inferChannelType(
                ch as unknown as Record<string, unknown>,
              ),
              lastActivityTs: extractLastActivityTs(
                ch as unknown as Record<string, unknown>,
              ),
            });
          }
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    this.conversations = conversations;
    this.updatedAt = Date.now();
    console.log(
      `[conversation-discovery] Tracking ${conversations.length} conversations`,
    );

    this.onRefresh?.();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferChannelType(
  ch: Record<string, unknown>,
): ConversationInfo["type"] {
  if (ch.is_im) return "im";
  if (ch.is_mpim) return "mpim";
  if (ch.is_private) return "private_channel";
  return "public_channel";
}

function extractLastActivityTs(ch: Record<string, unknown>): string | null {
  // Slack returns `updated` (epoch) or `last_read` for some channel types
  if (typeof ch.updated === "number" && ch.updated > 0) {
    return String(ch.updated);
  }
  if (typeof ch.last_read === "string" && ch.last_read !== "0000000000.000000") {
    return ch.last_read;
  }
  return null;
}
