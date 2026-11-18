import { mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      app.deps.db.prepare("SELECT 1").get();
      mkdirSync(app.deps.config.dataDir, { recursive: true });
      const probePath = path.join(app.deps.config.dataDir, `.ready-${randomUUID()}`);
      const probe = openSync(probePath, "wx", 0o600);
      closeSync(probe);
      unlinkSync(probePath);
      return { status: "ready" };
    } catch (error) {
      app.log.error(error, "Readiness check failed");
      return reply.code(503).send({ status: "not-ready" });
    }
  });
};