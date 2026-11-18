import { openDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLocalStorage } from "./services/storage.js";
import { processPending } from "./services/pipeline.js";
import { deliverPending } from "./services/webhooks.js";

const PIPELINE_INTERVAL_MS = 5_000;
const WEBHOOK_INTERVAL_MS = 2_000;
const PIPELINE_BATCH = 25;
const WEBHOOK_BATCH = 25;

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);
const storage = createLocalStorage(config.dataDir);
const app = buildApp({ config, db, storage });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error, "Server failed to start");
  db.close();
  process.exitCode = 1;
}

let pipelineRunning = true;
let webhookRunning = true;
let pipelineTimer: NodeJS.Timeout | undefined;
let webhookTimer: NodeJS.Timeout | undefined;

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
      await deliverPending(db, WEBHOOK_BATCH, { allowPrivate: config.webhookAllowPrivate, maxAttempts: config.webhookMaxAttempts });
    } catch (error) {
      app.log.error(error, "Webhook delivery iteration failed");
    }
  }
  if (webhookRunning) {
    webhookTimer = setTimeout(() => void runWebhooks(), WEBHOOK_INTERVAL_MS);
    webhookTimer.unref();
  }
}

if (process.env.NODE_ENV !== "test") {
  void runPipeline();
  void runWebhooks();
}

const shutdown = async () => {
  pipelineRunning = false;
  webhookRunning = false;
  if (pipelineTimer) clearTimeout(pipelineTimer);
  if (webhookTimer) clearTimeout(webhookTimer);
  await app.close();
  db.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
