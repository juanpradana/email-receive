import { mkdirSync } from "node:fs";
import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => {
    try {
      app.deps.db.prepare("SELECT 1").get();
      mkdirSync(app.deps.config.dataDir, { recursive: true });
      return { status: "ready" };
    } catch (error) {
      app.log.error(error, "Readiness check failed");
      return app.code(503).send({ status: "not-ready" });
    }
  });
};