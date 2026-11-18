import type { FastifyPluginAsync } from "fastify";
import { createIngestVerifier } from "../auth/ingestAuth.js";
import { IngestError, createIngestService } from "../services/ingest.js";

const RAW_CONTENT_TYPE = "message/rfc822";

export const ingestRoutes: FastifyPluginAsync = async (app) => {
  const verifier = createIngestVerifier(app.deps.config.ingestHmacSecret);
  const service = createIngestService({
    db: app.deps.db,
    storage: app.deps.storage,
    dedupeWindowHours: app.deps.config.dedupeWindowHours,
    maxMessageBytes: app.deps.config.maxMessageBytes,
  });

  app.addHook("onRequest", async (request, reply) => {
    const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith(RAW_CONTENT_TYPE)) {
      await reply.code(415).send({ error: "unsupported_media_type" });
    }
  });

  app.post("/v1/ingest", async (request, reply) => {
    const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""));
    if (bytes.length > app.deps.config.maxMessageBytes) {
      return reply.code(413).send({ error: "message_too_large" });
    }

    const verification = verifier.verify(request.headers["x-ingest-signature"] as string | undefined, bytes);
    if (!verification.ok) {
      return reply.code(401).send({ error: "invalid_signature", reason: verification.reason });
    }

    const envelopeFrom = request.headers["x-envelope-from"];
    const envelopeTo = request.headers["x-envelope-to"];
    if (typeof envelopeFrom !== "string" || typeof envelopeTo !== "string") {
      return reply.code(400).send({ error: "missing_envelope_headers" });
    }

    try {
      const result = await service.ingest({
        bytes,
        envelopeFrom,
        envelopeTo,
        receivedAt: typeof request.headers["x-received-at"] === "string" ? (request.headers["x-received-at"] as string) : undefined,
        source: request.ip,
      });
      return reply
        .code(result.duplicate ? 200 : 202)
        .send({ id: result.id, status: "pending", duplicate: result.duplicate });
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
};