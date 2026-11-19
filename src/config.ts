import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url(),
  INGEST_HMAC_SECRET: z.string().min(32),
  ADMIN_BOOTSTRAP_TOKEN: z.string().min(16),
  MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(26_214_400),
  DEDUPE_WINDOW_HOURS: z.coerce.number().int().nonnegative().default(24),
  SIGNED_URL_SECRET: z.string().min(32),
  WEBHOOK_ALLOW_PRIVATE: z.stringbool().default(false),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  RESEND_API_KEY: z.string().optional(),
  OUTBOUND_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
  WEB_DIST: z.string().optional(),
});

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  publicBaseUrl: string;
  ingestHmacSecret: string;
  adminBootstrapToken: string;
  maxMessageBytes: number;
  dedupeWindowHours: number;
  signedUrlSecret: string;
  webhookAllowPrivate: boolean;
  webhookMaxAttempts: number;
  retentionDays: number;
  resendApiKey?: string;
  outboundRateLimitPerHour: number;
  webDist?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }

  const dataDir = path.resolve(parsed.data.DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.resolve(parsed.data.DB_PATH ?? path.join(dataDir, "email.db"));

  return {
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    dataDir,
    dbPath,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL.replace(/\/$/, ""),
    ingestHmacSecret: parsed.data.INGEST_HMAC_SECRET,
    adminBootstrapToken: parsed.data.ADMIN_BOOTSTRAP_TOKEN,
    maxMessageBytes: parsed.data.MAX_MESSAGE_BYTES,
    dedupeWindowHours: parsed.data.DEDUPE_WINDOW_HOURS,
    signedUrlSecret: parsed.data.SIGNED_URL_SECRET,
    webhookAllowPrivate: parsed.data.WEBHOOK_ALLOW_PRIVATE,
    webhookMaxAttempts: parsed.data.WEBHOOK_MAX_ATTEMPTS,
    retentionDays: parsed.data.RETENTION_DAYS,
    resendApiKey: parsed.data.RESEND_API_KEY,
    outboundRateLimitPerHour: parsed.data.OUTBOUND_RATE_LIMIT_PER_HOUR,
    webDist: parsed.data.WEB_DIST ? path.resolve(parsed.data.WEB_DIST) : undefined,
  };
}
