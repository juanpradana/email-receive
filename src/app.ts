import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import type { Storage } from "./services/storage.js";
import { requireAdminToken } from "./auth/apiKey.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { ingestRoutes } from "./routes/ingest.js";

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
  app.addContentTypeParser("message/rfc822", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.register(healthRoutes);
  app.register(ingestRoutes);

  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", requireAdminToken(deps.config.adminBootstrapToken));
    adminApp.register(adminRoutes);
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDependencies;
  }
}