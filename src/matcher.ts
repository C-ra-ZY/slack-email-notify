import type { RulesConfig } from "./config.js";
import type { SlackMessage } from "./poller.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchType = "dm" | "mention" | "group_mention";

export interface MatchResult {
  message: SlackMessage;
  matchType: MatchType;
  /** Which user ID was matched (for mention) */
  matchedUserId?: string;
  /** Which group ID was mentioned (for group_mention) */
  matchedGroupId?: string;
}

// ---------------------------------------------------------------------------
// Matcher (§7 — DM / @user / @group detection)
// ---------------------------------------------------------------------------

/**
 * Given a Slack message and the rules config, determine if this message
 * should trigger a notification. Returns null if no match.
 *
 * A single message can match multiple rules; we return the highest-priority
 * match only (DM > @user mention > @group mention) and send one email (§7.2).
 */
export function matchMessage(
  rules: RulesConfig,
  msg: SlackMessage,
  selfUserId: string,
): MatchResult | null {
  // §7.5: Filter bot messages (avoid loops and noise)
  if (msg.subtype === "bot_message" || msg.subtype === "bot_add") {
    return null;
  }

  // §7.4: Message edits — respect notifyEdits config
  if (msg.subtype === "message_changed" && !rules.notifyEdits) {
    return null;
  }

  // §7.4: Message deletions — never notify
  if (msg.subtype === "message_deleted") {
    return null;
  }

  // §7.3: Thread reply handling
  // Pure thread replies don't notify. Thread replies WITH @user or @group do notify.
  const isThreadReply = msg.threadTs !== undefined && msg.threadTs !== msg.ts;

  // Priority 1: DM (§7.2 — im and mpim)
  // DMs don't apply thread reply filtering — all DMs notify
  if (
    rules.directMessages &&
    (msg.channelType === "im" || msg.channelType === "mpim")
  ) {
    // Only notify incoming DMs, not messages we sent ourselves
    if (msg.user === selfUserId) return null;
    return { message: msg, matchType: "dm" };
  }

  // §10.3: Extract text safely — non-text messages may have empty text
  const text = msg.text;

  // Priority 2: @user mention (§7.2)
  const mentionedUsers = extractUserMentions(text);
  for (const userId of rules.watchedMentions.userIds) {
    if (mentionedUsers.has(userId)) {
      // §7.3: Thread replies with @user → notify
      // Non-thread messages with @user → notify
      return { message: msg, matchType: "mention", matchedUserId: userId };
    }
  }

  // Priority 3: @usergroup mention (§7.2)
  const mentionedGroups = extractUserGroupMentions(text);
  for (const groupId of rules.watchedMentions.groupIds) {
    if (mentionedGroups.has(groupId)) {
      // §7.3: Thread replies with @group → notify
      return {
        message: msg,
        matchType: "group_mention",
        matchedGroupId: groupId,
      };
    }
  }

  // §7.3: Pure thread reply without mentions → no notification
  // Also: channel messages without DM/mention match → no notification
  if (isThreadReply) {
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Mention extraction
// ---------------------------------------------------------------------------

/** Extract `<@U0123456789>` user mentions */
function extractUserMentions(text: string): Set<string> {
  return extractMentions(text, /<@([A-Z0-9]+)>/g);
}

/** Extract `<!subteam^S0123456789>` or `<!subteam^S0123456789|@groupname>` */
function extractUserGroupMentions(text: string): Set<string> {
  return extractMentions(text, /<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/g);
}

function extractMentions(text: string, pattern: RegExp): Set<string> {
  const mentions = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (id) {
      mentions.add(id);
    }
  }
  return mentions;
}

// ---------------------------------------------------------------------------
// Deep link builder
// ---------------------------------------------------------------------------

export function buildSlackDeepLink(
  teamId: string,
  channelId: string,
  ts: string,
): string {
  return `https://app.slack.com/client/${teamId}/${channelId}/p${ts.replace(".", "")}`;
}
