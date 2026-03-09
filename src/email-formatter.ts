import type { MatchResult } from "./matcher.js";
import { buildSlackDeepLink } from "./matcher.js";
import type { NameResolver } from "./name-resolver.js";

// ---------------------------------------------------------------------------
// Email Formatter (§8.3, §8.4 — Subject/Body formatting for mobile push)
// ---------------------------------------------------------------------------

const MAX_BODY_LENGTH = 5_000; // §10.3: Truncate long messages

// ---------------------------------------------------------------------------
// Subject formatting (§8.3 — optimized for phone notification banner)
// ---------------------------------------------------------------------------

/**
 * Format email subject. Target: ≤ 60 chars for mobile banner visibility.
 *
 * Patterns (§8.3):
 *   [Slack] DM: @zhangsan
 *   [Slack] Mention: @zhangsan in #general
 *   [Slack] Group @backend-team: @lisi in #incidents
 */
export async function formatSubject(
  match: MatchResult,
  resolver: NameResolver,
): Promise<string> {
  const senderName = match.message.user
    ? await resolver.resolveUser(match.message.user)
    : "unknown";
  const channelName = await resolver.resolveChannel(match.message.channel);

  switch (match.matchType) {
    case "dm":
      return truncateSubject(`[Slack] DM: @${senderName}`);
    case "mention": {
      const targetName = match.matchedUserId
        ? await resolver.resolveUser(match.matchedUserId)
        : "user";
      return truncateSubject(
        `[Slack] @${targetName} mentioned by @${senderName} in #${channelName}`,
      );
    }
    case "group_mention": {
      const groupName = match.matchedGroupId
        ? await resolver.resolveGroup(match.matchedGroupId)
        : "group";
      return truncateSubject(
        `[Slack] @${groupName} mentioned by @${senderName} in #${channelName}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Body formatting (§8.4 — plain text)
// ---------------------------------------------------------------------------

/**
 * Format email body as plain text.
 *
 *   发送者: username (U0123456789)
 *   频道: #general (C0123456789)
 *   时间: 2026-03-08 12:00:00
 *
 *   ---
 *
 *   {message text}
 *
 *   ---
 *
 *   在 Slack 中查看: https://app.slack.com/...
 */
export async function formatBody(
  match: MatchResult,
  resolver: NameResolver,
): Promise<string> {
  const msg = match.message;
  const senderName = msg.user
    ? await resolver.resolveUser(msg.user)
    : "unknown";
  const channelName = await resolver.resolveChannel(msg.channel);
  const time = slackTsToDate(msg.ts);
  const deepLink = buildSlackDeepLink(msg.teamId, msg.channel, msg.ts);

  // §10.3: Extract readable content from message
  let text = extractReadableText(msg.text, msg.subtype);

  // §10.3: Truncate long messages
  if (text.length > MAX_BODY_LENGTH) {
    text =
      text.slice(0, MAX_BODY_LENGTH) +
      "\n\n[消息过长，已截断。请在 Slack 中查看完整内容]";
  }

  // Basic mrkdwn → plain text conversion
  text = stripMrkdwn(text);

  const lines = [
    `发送者: ${senderName} (${msg.user ?? "unknown"})`,
    `频道: #${channelName} (${msg.channel})`,
    `时间: ${time}`,
    "",
    "---",
    "",
    text,
    "",
    "---",
    "",
    `在 Slack 中查看: ${deepLink}`,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Non-text message handling (§10.3)
// ---------------------------------------------------------------------------

/**
 * §10.3: "非文本消息 — 尽量提取可读摘要，不因格式异常导致整个处理失败"
 *
 * When msg.text is empty or missing, provide a meaningful summary
 * based on the message subtype.
 */
function extractReadableText(
  text: string,
  subtype: string | undefined,
): string {
  // If there's actual text content, use it
  if (text.length > 0) {
    return text;
  }

  // Non-text messages: provide a summary based on subtype
  switch (subtype) {
    case "file_share":
      return "[文件分享]";
    case "file_comment":
      return "[文件评论]";
    case "file_mention":
      return "[文件提及]";
    case "channel_join":
      return "[用户加入频道]";
    case "channel_leave":
      return "[用户离开频道]";
    case "channel_topic":
      return "[频道主题已更改]";
    case "channel_purpose":
      return "[频道描述已更改]";
    case "channel_name":
      return "[频道名称已更改]";
    case "channel_archive":
      return "[频道已归档]";
    case "channel_unarchive":
      return "[频道已取消归档]";
    case "pinned_item":
      return "[消息已置顶]";
    case "unpinned_item":
      return "[消息已取消置顶]";
    case "me_message":
      return "[/me 动作消息]";
    case "reminder_add":
      return "[提醒已添加]";
    case "thread_broadcast":
      return "[线程广播消息]";
    default:
      return subtype ? `[${subtype}]` : "[非文本消息]";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateSubject(subject: string): string {
  if (subject.length <= 60) return subject;
  return subject.slice(0, 57) + "...";
}

function slackTsToDate(ts: string): string {
  const seconds = parseFloat(ts);
  if (isNaN(seconds)) return ts;
  const date = new Date(seconds * 1000);
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Minimal Slack mrkdwn → plain text conversion.
 * Handles the most common formatting; preserves readability.
 */
function stripMrkdwn(text: string): string {
  return (
    text
      // User mentions: <@U123> → @U123
      .replace(/<@([A-Z0-9]+)>/g, "@$1")
      // Channel links: <#C123|channel-name> → #channel-name
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      // URL links: <http://...|label> → label (http://...)
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
      // Bare URL links: <http://...> → http://...
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      // Bold: *text* → text
      .replace(/\*([^*]+)\*/g, "$1")
      // Italic: _text_ → text
      .replace(/_([^_]+)_/g, "$1")
      // Strikethrough: ~text~ → text
      .replace(/~([^~]+)~/g, "$1")
      // Code block: ```text``` → text
      .replace(/```([^`]*)```/g, "$1")
      // Inline code: `text` → text
      .replace(/`([^`]+)`/g, "$1")
      // Usergroup mentions: <!subteam^S123|@name> → @name
      .replace(/<!subteam\^[A-Z0-9]+\|(@[^>]+)>/g, "$1")
      // Usergroup mentions without label: <!subteam^S123> → @group:S123
      .replace(/<!subteam\^([A-Z0-9]+)>/g, "@group:$1")
  );
}
