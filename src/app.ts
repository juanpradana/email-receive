import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Storage } from "./services/storage.js";
import type { MailProvider } from "./services/mail/provider.js";
import { requireAdminToken, createAdminAuthGuard } from "./auth/apiKey.js";
import type { AdminAuthGuard } from "./auth/apiKey.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { adminAuthRoutes } from "./routes/adminAuth.js";
import { ingestRoutes } from "./routes/ingest.js";
import { messageRoutes } from "./routes/messages.js";
import { outboundRoutes } from "./routes/outbound.js";
import { webhookRoutes } from "./routes/webhooks.js";

export interface AppDependencies {
  config: AppConfig;
  db: Database.Database;
  storage: Storage;
  /** Outbound mail provider. Null when RESEND_API_KEY is unset; routes then answer 503. */
  mailProvider?: MailProvider | null;
  /** Directory the webmail SPA is built into; when present, it is served as static files. */
  webDist?: string;
  /** Admin authentication guard (session + legacy token). */
  adminAuthGuard: AdminAuthGuard;
}

/** Serves the built webmail SPA from `webDist` if that directory exists. */
async function serveStaticFiles(app: FastifyInstance, root: string, webDist?: string): Promise<void> {
  if (!webDist || !existsSync(webDist)) return;

  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, {
    root: webDist,
    index: "index.html",
  });
  // Any GET that is not an API route or a real static asset falls through to
  // index.html so the SPA router can take over.
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/v1")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found" });
  });
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-ingest-signature",
        "err.config.headers.Authorization",
        "err.config.headers.authorization",
        "err.request.headers.Authorization",
        "err.request.headers.authorization",
      ],
    },
    bodyLimit: deps.config.maxMessageBytes,
  });

  app.decorate("deps", { ...deps, adminAuthGuard: deps.adminAuthGuard });
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
  app.register(outboundRoutes);
  app.register(webhookRoutes);

  // Public admin auth routes (login/logout) — no auth required
  app.register(adminAuthRoutes);

  // Protected admin routes — require admin session or legacy token
  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", deps.adminAuthGuard.authenticateAdmin);
    adminApp.register(adminRoutes);
  });

  // Static webmail is registered last so API routes are matched first.
  app.register(async () => {
    await serveStaticFiles(app, process.cwd(), deps.webDist ?? resolve(process.cwd(), "web/dist"));
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDependencies;
  }
}
