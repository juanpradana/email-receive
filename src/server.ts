import { openDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLocalStorage } from "./services/storage.js";

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

const shutdown = async () => {
  await app.close();
  db.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
