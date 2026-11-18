import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Storage } from "./services/storage.js";
import { requireAdminToken } from "./auth/apiKey.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { ingestRoutes } from "./routes/ingest.js";
import { messageRoutes } from "./routes/messages.js";
import { webhookRoutes } from "./routes/webhooks.js";

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
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    request.log.error({ err: error }, "request failed");
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "internal_error" : "request_error" });
  });
  app.addContentTypeParser("message/rfc822", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.register(healthRoutes);
  app.register(ingestRoutes);
  app.register(messageRoutes);
  app.register(webhookRoutes);

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