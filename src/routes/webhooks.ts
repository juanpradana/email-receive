import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createApiKeyGuard } from "../auth/apiKey.js";
import { createApiKeysRepo } from "../db/repo/apiKeys.js";
import { createMessagesRepo } from "../db/repo/messages.js";
import { assertWebhookUrlShape } from "../lib/webhookUrl.js";
import { createWebhooksRepo, enqueueMessageWebhooks } from "../services/webhooks.js";

const createBody = z.object({
  url: z.string().url(),
  events: z.array(z.enum(["message.received", "*"])).min(1).default(["message.received"]),
});

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const guard = createApiKeyGuard(createApiKeysRepo(app.deps.db));
  app.addHook("preHandler", guard.authenticate);
  app.addHook("preHandler", guard.requireAdmin);

  const repo = () => createWebhooksRepo(app.deps.db);

  app.get("/v1/webhooks", async (request) => ({
    endpoints: repo()
      .list(request.auth!.tenantId)
      .map((row) => ({
        id: row.id,
        url: row.url,
        events: JSON.parse(row.events_json) as string[],
        active: row.active === 1,
        createdAt: row.created_at,
      })),
  }));

  app.post("/v1/webhooks", async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_webhook" });
    }

    try {
      // Shape checks run at creation; the DNS-resolved private-address check runs at
      // delivery time so a rebinding hostname cannot slip through a stale cached answer.
      assertWebhookUrlShape(parsed.data.url, app.deps.config.webhookAllowPrivate);
    } catch (error) {
      return reply.code(400).send({
        error: "unsafe_webhook_url",
        message: error instanceof Error ? error.message : "invalid webhook URL",
      });
    }

    const row = repo().create(request.auth!.tenantId, parsed.data);
    return reply.code(201).send({
      endpoint: {
        id: row.id,
        url: row.url,
        events: parsed.data.events,
        secret: row.secret,
        createdAt: row.created_at,
      },
    });
  });

  app.delete("/v1/webhooks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return repo().remove(request.auth!.tenantId, id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "webhook_not_found" });
  });

  app.get("/v1/webhooks/:id/deliveries", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!repo().find(request.auth!.tenantId, id)) {
      return reply.code(404).send({ error: "webhook_not_found" });
    }
    return {
      deliveries: repo()
        .deliveries(request.auth!.tenantId, id)
        .map((row) => ({
          id: row.id,
          messageId: row.message_id,
          event: row.event,
          status: row.status,
          attempts: row.attempts,
          responseStatus: row.response_status,
          lastError: row.last_error,
          nextAttemptAt: row.next_attempt_at,
          deliveredAt: row.delivered_at,
          createdAt: row.created_at,
        })),
    };
  });

  app.post("/v1/messages/:id/redeliver", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const message = createMessagesRepo(app.deps.db).findById(request.auth!.tenantId, id);
    if (!message) return reply.code(404).send({ error: "message_not_found" });
    const created = enqueueMessageWebhooks(
      app.deps.db,
      request.auth!.tenantId,
      message.id,
      app.deps.config.publicBaseUrl,
    );
    return reply.code(202).send({ queued: created });
  });
};