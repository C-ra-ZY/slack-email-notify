import type { SlackClient } from "./slack-client.js";

// ---------------------------------------------------------------------------
// Name Resolver (§8.5 — User/Channel ID → display name cache)
// ---------------------------------------------------------------------------

const CACHE_REFRESH_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 10_000; // LRU cap

export class NameResolver {
  private readonly slack: SlackClient;

  private userCache = new Map<string, string>();
  private channelCache = new Map<string, string>();
  private groupCache = new Map<string, string>();  // Review P2 #4
  private lastUserRefresh = 0;
  private lastChannelRefresh = 0;
  private lastGroupRefresh = 0;  // Review P2 #4

  constructor(slack: SlackClient) {
    this.slack = slack;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Resolve a User ID to a display name. Returns the ID as fallback. */
  async resolveUser(userId: string): Promise<string> {
    await this.ensureUserCache();

    const cached = this.userCache.get(userId);
    if (cached) return cached;

    // Try single lookup for cache miss
    try {
      const result = await this.slack.call((c) =>
        c.users.info({ user: userId }),
      );
      if (result.user) {
        const name = pickUserName(
          result.user as unknown as Record<string, unknown>,
        );
        this.userCache.set(userId, name);
        this.evictIfNeeded(this.userCache);
        return name;
      }
    } catch {
      // Fallback to raw ID
    }

    return userId;
  }

  /** Resolve a Channel ID to a channel name. Returns the ID as fallback. */
  async resolveChannel(channelId: string): Promise<string> {
    await this.ensureChannelCache();

    const cached = this.channelCache.get(channelId);
    if (cached) return cached;

    // Try single lookup for cache miss
    try {
      const result = await this.slack.call((c) =>
        c.conversations.info({ channel: channelId }),
      );
      if (result.channel) {
        const name = pickChannelName(
          result.channel as unknown as Record<string, unknown>,
          this.userCache,
        );
        this.channelCache.set(channelId, name);
        this.evictIfNeeded(this.channelCache);
        return name;
      }
    } catch {
      // Fallback to raw ID
    }

    return channelId;
  }

  /** Resolve a Usergroup ID to a handle. Returns the ID as fallback. */
  async resolveGroup(groupId: string): Promise<string> {
    // Review P2 #4: Use TTL cache like user/channel resolvers
    await this.ensureGroupCache();

    const cached = this.groupCache.get(groupId);
    if (cached) return cached;

    return groupId;
  }

  // -------------------------------------------------------------------------
  // Cache population
  // -------------------------------------------------------------------------

  private async ensureUserCache(): Promise<void> {
    const now = Date.now();
    if (
      this.userCache.size > 0 &&
      now - this.lastUserRefresh < CACHE_REFRESH_MS
    ) {
      return;
    }

    try {
      console.log("[name-resolver] Refreshing user cache...");
      let cursor: string | undefined;

      do {
        const result = await this.slack.call((c) => {
          const args: Record<string, unknown> = { limit: 200 };
          if (cursor) args.cursor = cursor;
          return c.users.list(
            args as Parameters<typeof c.users.list>[0],
          );
        });

        if (result.members) {
          for (const member of result.members) {
            if (member.id) {
              this.userCache.set(
                member.id,
                pickUserName(
                  member as unknown as Record<string, unknown>,
                ),
              );
            }
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      this.lastUserRefresh = now;
      console.log(`[name-resolver] Cached ${this.userCache.size} users`);
    } catch (err) {
      console.error(
        "[name-resolver] Failed to refresh user cache:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async ensureChannelCache(): Promise<void> {
    const now = Date.now();
    if (
      this.channelCache.size > 0 &&
      now - this.lastChannelRefresh < CACHE_REFRESH_MS
    ) {
      return;
    }

    try {
      console.log("[name-resolver] Refreshing channel cache...");
      let cursor: string | undefined;

      do {
        const result = await this.slack.call((c) => {
          const args: Record<string, unknown> = {
            types: "im,mpim,public_channel,private_channel",
            limit: 200,
          };
          if (cursor) args.cursor = cursor;
          return c.conversations.list(
            args as Parameters<typeof c.conversations.list>[0],
          );
        });

        if (result.channels) {
          for (const ch of result.channels) {
            if (ch.id) {
              this.channelCache.set(
                ch.id,
                pickChannelName(
                  ch as unknown as Record<string, unknown>,
                  this.userCache,
                ),
              );
            }
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      this.lastChannelRefresh = now;
      console.log(
        `[name-resolver] Cached ${this.channelCache.size} channels`,
      );
    } catch (err) {
      console.error(
        "[name-resolver] Failed to refresh channel cache:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Review P2 #4: Group cache with same TTL pattern as user/channel
  private async ensureGroupCache(): Promise<void> {
    const now = Date.now();
    if (
      this.groupCache.size > 0 &&
      now - this.lastGroupRefresh < CACHE_REFRESH_MS
    ) {
      return;
    }

    try {
      console.log("[name-resolver] Refreshing group cache...");
      const result = await this.slack.call((c) => c.usergroups.list());
      if (result.usergroups) {
        for (const g of result.usergroups) {
          if (g.id && g.handle) {
            this.groupCache.set(g.id, g.handle);
          }
        }
      }
      this.lastGroupRefresh = now;
      console.log(`[name-resolver] Cached ${this.groupCache.size} groups`);
    } catch (err) {
      console.error(
        "[name-resolver] Failed to refresh group cache:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Evict oldest entries when cache exceeds max size */
  private evictIfNeeded(cache: Map<string, string>): void {
    if (cache.size <= MAX_CACHE_SIZE) return;

    const excess = cache.size - MAX_CACHE_SIZE;
    const keys = cache.keys();
    for (let i = 0; i < excess; i++) {
      const next = keys.next();
      if (!next.done) {
        cache.delete(next.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Name picking helpers
// ---------------------------------------------------------------------------

function pickUserName(user: Record<string, unknown>): string {
  const profile = user.profile as Record<string, unknown> | undefined;
  if (profile) {
    if (typeof profile.display_name === "string" && profile.display_name) {
      return profile.display_name;
    }
    if (typeof profile.real_name === "string" && profile.real_name) {
      return profile.real_name;
    }
  }
  if (typeof user.real_name === "string" && user.real_name) {
    return user.real_name;
  }
  if (typeof user.name === "string" && user.name) {
    return user.name;
  }
  return (user.id as string) ?? "unknown";
}

function pickChannelName(
  ch: Record<string, unknown>,
  userCache: Map<string, string>,
): string {
  // §8.5: DM channels show the other user's name
  if (ch.is_im && typeof ch.user === "string") {
    return userCache.get(ch.user) ?? ch.user;
  }

  if (typeof ch.name === "string" && ch.name) {
    return ch.name;
  }

  return (ch.id as string) ?? "unknown";
}
