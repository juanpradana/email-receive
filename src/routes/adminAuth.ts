import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const loginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1),
});

export const adminAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/admin/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const guard = request.server.deps.adminAuthGuard;
    const token = await guard.login(body.email, body.password);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { adminSessionToken: token };
  });

  app.post("/v1/admin/logout", async (request, reply) => {
    const guard = request.server.deps.adminAuthGuard;
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const token = auth.slice("Bearer ".length).trim();
    const ok = await guard.logout(token);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "session_not_found" });
  });
};
