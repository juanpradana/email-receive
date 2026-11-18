import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import type { Storage } from "./services/storage.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDependencies {
  config: AppConfig;
  db: Database.Database;
  storage: Storage;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.x-ingest-signature"],
    },
    bodyLimit: deps.config.maxMessageBytes,
  });

  app.decorate("deps", deps);
  app.register(healthRoutes, { prefix: "/" });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDependencies;
  }
}
