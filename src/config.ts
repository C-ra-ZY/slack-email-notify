import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment variables schema (§8.2)
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // Slack — required
  SLACK_USER_TOKEN: z.string().min(1, "SLACK_USER_TOKEN is required"),

  // Slack — optional (Socket Mode acceleration layer)
  SLACK_APP_TOKEN: z.string().min(1).optional(),
  ENABLE_SOCKET_MODE: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Email — required
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().min(1, "SMTP_USER is required"),
  SMTP_PASS: z.string().min(1, "SMTP_PASS is required"),
  EMAIL_TO: z.string().min(1, "EMAIL_TO is required"),

  // IMAP — optional (sent mail cleanup)
  IMAP_HOST: z.string().min(1).optional(),
  IMAP_PORT: z.coerce.number().int().positive().optional(),
  IMAP_USER: z.string().min(1).optional(),
  IMAP_PASS: z.string().min(1).optional(),

  // Monitoring — recommended
  HEALTHCHECK_PING_URL: z.string().url().optional(),
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),

  // Rules (previously in config/rules.json, now unified into .env)
  RULES_DIRECT_MESSAGES: z
    .enum(["true", "false", "1", "0", ""])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  RULES_USER_IDS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  RULES_GROUP_IDS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  RULES_NOTIFY_EDITS: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // State
  STATE_DIR: z.string().default("data/state"),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type AppConfig = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Derived rules config (for matcher compatibility)
// ---------------------------------------------------------------------------

export interface RulesConfig {
  directMessages: boolean;
  watchedMentions: {
    userIds: string[];
    groupIds: string[];
  };
  notifyEdits: boolean;
}

export function rulesFromConfig(config: AppConfig): RulesConfig {
  return {
    directMessages: config.RULES_DIRECT_MESSAGES,
    watchedMentions: {
      userIds: config.RULES_USER_IDS,
      groupIds: config.RULES_GROUP_IDS,
    },
    notifyEdits: config.RULES_NOTIFY_EDITS,
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
