import { SocketModeClient } from "@slack/socket-mode";

import type { AppConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Socket Mode Acceleration Layer (§4.4 — trigger incremental sync)
// ---------------------------------------------------------------------------

/**
 * §4.4 Socket Mode semantics:
 *
 * "Socket Mode 收到某会话相关事件后，立即触发该会话的一次增量同步。
 *  最终仍以 conversations.history 拉到的消息为准。"
 *
 * This means Socket Mode does NOT process messages directly. Instead, it
 * notifies the poller to immediately sync a specific conversation, reducing
 * latency while maintaining polling as the correctness layer.
 */
export class SocketModeAccelerator {
  private readonly client: SocketModeClient;

  /** Callback to trigger an incremental sync on a conversation */
  onSyncRequest: ((channelId: string) => Promise<void>) | null = null;

  /** Connection status for health monitor */
  connected = false;

  constructor(config: AppConfig) {
    if (!config.SLACK_APP_TOKEN) {
      throw new Error("SocketModeAccelerator requires SLACK_APP_TOKEN");
    }

    this.client = new SocketModeClient({
      appToken: config.SLACK_APP_TOKEN,
    });
  }

  async start(): Promise<void> {
    // Listen for message events — trigger sync, don't process directly
    this.client.on("message", async ({ event, ack }) => {
      await ack();
      await this.handleEvent(event as Record<string, unknown>);
    });

    // Track connection status
    this.client.on("connected", () => {
      this.connected = true;
      console.log("[socket-mode] Connected");
    });

    this.client.on("disconnected", () => {
      this.connected = false;
      console.warn(
        "[socket-mode] Disconnected — poller continues as correctness layer",
      );
    });

    this.client.on("reconnecting", () => {
      this.connected = false;
      console.log("[socket-mode] Reconnecting...");
    });

    await this.client.start();
    console.log("[socket-mode] Started (acceleration layer)");
  }

  stop(): void {
    this.connected = false;
    void this.client.disconnect();
  }

  // -------------------------------------------------------------------------
  // Event handling — trigger sync, not direct processing (§4.4)
  // -------------------------------------------------------------------------

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const channel = event.channel as string | undefined;

    if (!channel) return;

    // §4.4: "立即触发该会话的一次增量同步"
    if (this.onSyncRequest) {
      try {
        console.log(
          `[socket-mode] Event in ${channel} — triggering incremental sync`,
        );
        await this.onSyncRequest(channel);
      } catch (err) {
        console.error(
          "[socket-mode] Error triggering sync:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
