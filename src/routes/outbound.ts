import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createApiKeyGuard } from "../auth/apiKey.js";
import { createApiKeysRepo } from "../db/repo/apiKeys.js";
import { createOutboundDeliveriesRepo, createOutboundRepo } from "../db/repo/outbound.js";
import { createTenantSmtpConfigsRepo } from "../db/repo/tenantSmtpConfigs.js";
import { createTenantsRepo } from "../db/repo/tenants.js";

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 998;

const address = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/, "invalid email address");

const sendBody = z
  .object({
    fromAddr: address,
    to: z.array(address).min(1).max(MAX_RECIPIENTS),
    cc: z.array(address).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(address).max(MAX_RECIPIENTS).optional(),
    subject: z.string().max(MAX_SUBJECT),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => Boolean(value.html?.trim() || value.text?.trim()), {
    message: "html or text is required",
    path: ["text"],
  })
  .refine(
    (value) =>
      value.to.length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) <= MAX_RECIPIENTS,
    { message: `no more than ${MAX_RECIPIENTS} recipients in total`, path: ["to"] },
  );

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(["pending", "sent", "failed", "bounced"]).optional(),
});

/**
 * Returns the domain portion of an address, lowercased. Returns undefined when
 * the address has no usable domain.
 */
export function domainOf(fromAddr: string): string | undefined {
  const at = fromAddr.lastIndexOf("@");
  if (at <= 0) return undefined;
  return fromAddr.slice(at + 1).trim().toLowerCase() || undefined;
}

export const outboundRoutes: FastifyPluginAsync = async (app) => {
  const guard = createApiKeyGuard(createApiKeysRepo(app.deps.db));
  app.addHook("preHandler", guard.authenticate);

  const outbound = () => createOutboundRepo(app.deps.db);
  const deliveries = () => createOutboundDeliveriesRepo(app.deps.db);
  const smtpConfigs = () => createTenantSmtpConfigsRepo(app.deps.db);

  app.get("/v1/outbound", async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    return {
      messages: outbound()
        .listByTenant(request.auth!.tenantId, { limit: parsed.data.limit, status: parsed.data.status })
        .map((row) => ({
          id: row.id,
          fromAddr: row.from_addr,
          to: JSON.parse(row.to_json) as string[],
          cc: JSON.parse(row.cc_json) as string[],
          bcc: JSON.parse(row.bcc_json) as string[],
          subject: row.subject,
          status: row.status,
          error: row.error,
          messageId: row.message_id,
          deliveredAt: row.delivered_at,
          createdAt: row.created_at,
        })),
    };
  });

  app.post("/v1/outbound", { preHandler: guard.requireAdmin }, async (request, reply) => {
    const parsed = sendBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_error",
        details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }

    const tenantId = request.auth!.tenantId;
    const input = parsed.data;

    const domain = domainOf(input.fromAddr);
    if (!domain || !createTenantsRepo(app.deps.db).listDomains(tenantId).includes(domain)) {
      return reply.code(400).send({ error: "from_addr_not_allowed" });
    }

    if (!app.deps.mailProvider) {
      return reply.code(503).send({ error: "mail_provider_not_configured" });
    }

    const now = new Date().toISOString();
    const allowed = smtpConfigs().consume(tenantId, {
      hourlyLimit: app.deps.config.outboundRateLimitPerHour,
      now,
    });
    if (!allowed) {
      return reply.code(429).send({ error: "outbound_rate_limited" });
    }

    const row = outbound().insert({
      tenantId,
      fromAddr: input.fromAddr,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      createdAt: now,
    });
    const delivery = deliveries().create({ messageId: row.id, nextAttemptAt: now });

    const result = await app.deps.mailProvider.send({
      fromAddr: input.fromAddr,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });

    if (result.accepted) {
      const deliveredAt = new Date().toISOString();
      outbound().markSent(row.id, result.resendMessageId ?? "", deliveredAt);
      deliveries().markDelivered(delivery.id, result.resendMessageId ?? "", deliveredAt);
      return reply.code(202).send({
        outboundId: row.id,
        resendMessageId: result.resendMessageId ?? null,
        accepted: true,
      });
    }

    // A provider rejection is terminal for this attempt — the address or the
    // domain will not start working on a retry. Keep the row and the error so
    // the webmail can surface it instead of silently dropping the message.
    outbound().markFailed(row.id, result.error ?? "send_failed");
    deliveries().markDead(delivery.id, 1, result.error ?? "send_failed");
    return reply.code(202).send({
      outboundId: row.id,
      resendMessageId: null,
      accepted: false,
      error: result.error ?? "send_failed",
    });
  });

  app.get("/v1/outbound/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = outbound().findById(request.auth!.tenantId, id);
    if (!row) return reply.code(404).send({ error: "outbound_not_found" });
    const delivery = deliveries().findByMessage(row.id);

    return {
      message: {
        id: row.id,
        fromAddr: row.from_addr,
        to: JSON.parse(row.to_json) as string[],
        cc: JSON.parse(row.cc_json) as string[],
        bcc: JSON.parse(row.bcc_json) as string[],
        subject: row.subject,
        html: row.html,
        text: row.text,
        status: row.status,
        error: row.error,
        messageId: row.message_id,
        deliveredAt: row.delivered_at,
        createdAt: row.created_at,
        delivery: delivery
          ? {
              status: delivery.status,
              attempts: delivery.attempts,
              lastError: delivery.last_error,
              nextAttemptAt: delivery.next_attempt_at,
            }
          : null,
      },
    };
  });
};