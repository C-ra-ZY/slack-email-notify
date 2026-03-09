import { loadConfig, rulesFromConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import { SlackClient } from "./slack-client.js";
import { ConversationDiscovery } from "./conversation-discovery.js";
import { Poller, type SlackMessage } from "./poller.js";
import { matchMessage, type MatchResult } from "./matcher.js";
import { EmailSender } from "./email-sender.js";
import { formatSubject, formatBody } from "./email-formatter.js";
import { NameResolver } from "./name-resolver.js";
import { HealthMonitor } from "./health.js";
import { SocketModeAccelerator } from "./socket-mode.js";
import { installTimestampedConsole } from "./logging.js";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

installTimestampedConsole();

async function main(): Promise<void> {
  console.log("[main] china-notify v2 starting...");

  // 1. Load config & rules
  const config = loadConfig();
  const rules = rulesFromConfig(config);
  console.log(`[main] Log level: ${config.LOG_LEVEL}`);
  console.log(
    `[main] Mode: ${config.ENABLE_SOCKET_MODE ? "polling + socket" : "polling-only"}`,
  );

  // 2. Initialize state store (§6 — directory model)
  const stateStore = new StateStore(config.STATE_DIR);

  // 3. Initialize shared Slack client with rate controller (§5.3)
  const slack = new SlackClient(config.SLACK_USER_TOKEN);

  // 4. Initialize modules
  const discovery = new ConversationDiscovery(slack);
  discovery.onRefresh = () => {
    stateStore.pruneConversations(discovery.getConversationIds());
  };
  const emailSender = new EmailSender(config, stateStore);
  const resolver = new NameResolver(slack);
  const health = new HealthMonitor(config, stateStore, emailSender);

  // 5. Verify SMTP before starting
  const smtpOk = await emailSender.verify();
  if (!smtpOk) {
    console.error(
      "[main] SMTP verification failed — continuing but emails may fail",
    );
  }

  // 6. Start health monitor (HTTP endpoint + heartbeat + startup email)
  await health.start();

  // selfUserId set after poller.start() — used by processMessage closure
  let selfUserId = "";

  // 7. Message processing pipeline
  // Returns true if notification was sent (or no notification needed), false on send failure.
  const processMessage = async (msg: SlackMessage): Promise<boolean> => {
    const match = matchMessage(rules, msg, selfUserId);
    if (!match) return true; // No match = successfully "processed" (skip)

    const sent = await sendNotification(match, emailSender, resolver);
    if (sent) {
      stateStore.markProcessed(msg.channel, msg.ts);
      stateStore.recordEventProcessed();
      return true;
    }

    // Send failed — do NOT mark as processed so it will be retried
    return false;
  };

  // 8. Start poller (correctness layer — always runs)
  const poller = new Poller(slack, stateStore, discovery);
  poller.onMessages = async (messages: SlackMessage[]): Promise<string | null> => {
    let lastSuccessTs: string | null = null;

    for (const msg of messages) {
      const ok = await processMessage(msg);
      if (ok) {
        lastSuccessTs = msg.ts;
      } else {
        // Stop processing on first send failure — don't skip messages
        console.warn(
          `[main] Send failed for ${msg.channel}:${msg.ts}, stopping batch`,
        );
        break;
      }
    }

    return lastSuccessTs;
  };

  // §9.3: Token invalidation → unhealthy
  poller.onTokenInvalid = () => {
    health.setTokenInvalid();
  };

  try {
    // Auth + discovery done → mark connected before first poll round completes
    const result = await poller.start();
    selfUserId = result.selfUserId;
    health.setSlackConnected(true);
    console.log("[main] Poller started");
  } catch (err) {
    console.error(
      "[main] Poller failed to start:",
      err instanceof Error ? err.message : err,
    );
    health.setSlackConnected(false);
    // Don't exit — health endpoint should still be available for diagnostics
  }

  // 9. Start Socket Mode acceleration (optional — §4.4)
  let socketMode: SocketModeAccelerator | null = null;
  if (config.ENABLE_SOCKET_MODE && config.SLACK_APP_TOKEN) {
    try {
      socketMode = new SocketModeAccelerator(config);

      // §4.4: Socket Mode triggers incremental sync, not direct processing
      socketMode.onSyncRequest = async (channelId: string) => {
        await poller.syncConversation(channelId);
      };

      await socketMode.start();
      health.setSocketMode(socketMode);
      console.log("[main] Socket Mode acceleration started");
    } catch (err) {
      console.warn(
        "[main] Socket Mode failed to start (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 10. Monitor state persistence (§9.3: persistence failure → unhealthy)
  const persistenceCheck = setInterval(() => {
    const ok = stateStore.persist();
    health.setPersistenceFailing(!ok);
  }, 60_000); // Check every minute

  // 11. Graceful shutdown
  const shutdown = () => {
    console.log("[main] Shutting down...");
    clearInterval(persistenceCheck);
    poller.stop();
    socketMode?.stop();
    health.stop();
    stateStore.persist();
    console.log("[main] Goodbye");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[main] china-notify v2 is running");
}

// ---------------------------------------------------------------------------
// Notification sender
// ---------------------------------------------------------------------------

async function sendNotification(
  match: MatchResult,
  emailSender: EmailSender,
  resolver: NameResolver,
): Promise<boolean> {
  try {
    const subject = await formatSubject(match, resolver);
    const body = await formatBody(match, resolver);

    const sent = await emailSender.send(subject, body);
    if (sent) {
      console.log(`[main] Notification sent: ${subject}`);
      return true;
    } else {
      console.error(`[main] Failed to send notification: ${subject}`);
      return false;
    }
  } catch (err) {
    console.error(
      "[main] Error sending notification:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
