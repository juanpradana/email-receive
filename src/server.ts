import { resolve } from "node:path";
import { openDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLocalStorage } from "./services/storage.js";
import { createMailProvider } from "./services/mail/index.js";
import { processPending } from "./services/pipeline.js";
import { deliverPending } from "./services/webhooks.js";
import { deliverOutboundPending } from "./services/outbound.js";
import { purgeExpired, resetHourlyUsage } from "./jobs/retention.js";
import { createAdminAuthGuard } from "./auth/apiKey.js";

const PIPELINE_INTERVAL_MS = 5_000;
const WEBHOOK_INTERVAL_MS = 2_000;
const OUTBOUND_INTERVAL_MS = 10_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const PIPELINE_BATCH = 25;
const WEBHOOK_BATCH = 25;
const OUTBOUND_BATCH = 25;
const RETENTION_BATCH = 100;

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);
const storage = createLocalStorage(config.dataDir);
const webDist = config.webDist ?? resolve(process.cwd(), "web/dist");

let mailProvider: import("./services/mail/provider.js").MailProvider | null = null;
if (config.resendApiKey) {
  try {
    mailProvider = createMailProvider(config);
  } catch (error) {
    process.env.LOG_LEVEL === "debug" && console.error(error);
    mailProvider = null;
  }
}

const adminAuthGuard = createAdminAuthGuard(db, config.adminBootstrapToken);
adminAuthGuard.ensureBootstrapUser(
  config.adminBootstrapEmail ?? "admin@localhost",
  config.adminBootstrapPassword ?? "change-me",
);

const app = buildApp({ config, db, storage, mailProvider, webDist, adminAuthGuard });
try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error, "Server failed to start");
  db.close();
  process.exitCode = 1;
}

let pipelineRunning = true;
let webhookRunning = true;
let outboundRunning = true;
let retentionRunning = true;
let pipelineTimer: NodeJS.Timeout | undefined;
let webhookTimer: NodeJS.Timeout | undefined;
let outboundTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let pipelineInFlight: Promise<void> | undefined;
let webhookInFlight: Promise<void> | undefined;
let outboundInFlight: Promise<void> | undefined;
let retentionInFlight: Promise<void> | undefined;

async function runPipeline(): Promise<void> {
  while (pipelineRunning) {
    try {
      const stored = await processPending(db, storage, PIPELINE_BATCH, config.publicBaseUrl);
      if (stored < PIPELINE_BATCH) break;
    } catch (error) {
      app.log.error(error, "MIME pipeline iteration failed");
      break;
    }
  }
  if (pipelineRunning) {
    pipelineTimer = setTimeout(() => void runPipeline(), PIPELINE_INTERVAL_MS);
    pipelineTimer.unref();
  }
}

async function runWebhooks(): Promise<void> {
  if (webhookRunning) {
    try {
      await deliverPending(db, WEBHOOK_BATCH, {
        allowPrivate: config.webhookAllowPrivate,
        maxAttempts: config.webhookMaxAttempts,
      });
    } catch (error) {
      app.log.error(error, "Webhook delivery iteration failed");
    }
  }
  if (webhookRunning) {
    webhookTimer = setTimeout(() => void runWebhooks(), WEBHOOK_INTERVAL_MS);
    webhookTimer.unref();
  }
}

async function runOutbound(): Promise<void> {
  while (outboundRunning && mailProvider) {
    try {
      const delivered = await deliverOutboundPending(db, mailProvider, OUTBOUND_BATCH, new Date());
      if (delivered < OUTBOUND_BATCH) break;
    } catch (error) {
      app.log.error(error, "Outbound delivery iteration failed");
      break;
    }
  }
  if (outboundRunning) {
    outboundTimer = setTimeout(() => void runOutbound(), OUTBOUND_INTERVAL_MS);
    outboundTimer.unref();
  }
}

async function runRetention(): Promise<void> {
  if (retentionRunning) {
    try {
      resetHourlyUsage(db, new Date());
    } catch (error) {
      app.log.error(error, "Outbound hourly usage reset failed");
    }
  }
  if (retentionRunning && config.retentionDays > 0) {
    try {
      const removed = await purgeExpired(db, storage, config.retentionDays, new Date());
      if (removed > 0) app.log.info({ removed }, "Retention purge removed messages");
    } catch (error) {
      app.log.error(error, "Retention purge failed");
    }
  }
  if (retentionRunning) {
    retentionTimer = setTimeout(() => void runRetention(), RETENTION_INTERVAL_MS);
    retentionTimer.unref();
  }
}

if (process.env.NODE_ENV !== "test") {
  pipelineInFlight = runPipeline();
  webhookInFlight = runWebhooks();
  outboundInFlight = runOutbound();
  retentionInFlight = runRetention();
}

let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  pipelineRunning = false;
  webhookRunning = false;
  outboundRunning = false;
  retentionRunning = false;
  if (pipelineTimer) clearTimeout(pipelineTimer);
  if (webhookTimer) clearTimeout(webhookTimer);
  if (outboundTimer) clearTimeout(outboundTimer);
  if (retentionTimer) clearTimeout(retentionTimer);

  // Stop accepting new requests first, then let the background loops drain
  // their current iteration before closing the database they are using.
  await app.close();
  await Promise.allSettled([pipelineInFlight, webhookInFlight, outboundInFlight, retentionInFlight]);
  db.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());