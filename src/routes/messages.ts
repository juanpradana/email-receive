import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createApiKeyGuard } from "../auth/apiKey.js";
import { createApiKeysRepo } from "../db/repo/apiKeys.js";
import type { MessageRow } from "../db/repo/messages.js";
import { createMessagesRepo } from "../db/repo/messages.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { contentDisposition } from "../lib/fsSafe.js";

interface AttachmentRow {
  id: string;
  part_index: number;
  filename: string;
  content_type: string;
  disposition: string | null;
  content_id: string | null;
  is_inline: number;
  size_bytes: number;
  path: string;
}

function toAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    partIndex: row.part_index,
    filename: row.filename,
    contentType: row.content_type,
    disposition: row.disposition,
    contentId: row.content_id,
    isInline: row.is_inline === 1,
    sizeBytes: row.size_bytes,
  };
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  subject: z.string().trim().min(1).optional(),
});

export const messageRoutes: FastifyPluginAsync = async (app) => {
  const guard = createApiKeyGuard(createApiKeysRepo(app.deps.db));
  app.addHook("preHandler", guard.authenticate);

  const messages = () => createMessagesRepo(app.deps.db);

  const findOwned = (tenantId: string, id: string): MessageRow | undefined => messages().findById(tenantId, id);

  const findAttachment = (tenantId: string, messageId: string, attachmentId: string): AttachmentRow | undefined =>
    app.deps.db
      .prepare(
        `SELECT a.* FROM attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.tenant_id = ? AND m.id = ? AND m.deleted_at IS NULL AND a.id = ?`,
      )
      .get(tenantId, messageId, attachmentId) as AttachmentRow | undefined;

  const recipients = (messageId: string, kind: "to" | "cc" | "bcc") =>
    app.deps.db
      .prepare("SELECT address, name FROM message_recipients WHERE message_id = ? AND kind = ? ORDER BY rowid")
      .all(messageId, kind) as Array<{ address: string; name: string | null }>;

  app.get("/v1/messages", async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query" });
    }
    const { limit, cursor, from, to, subject } = parsed.data;
    let decoded;
    if (cursor) {
      try {
        decoded = decodeCursor(cursor);
      } catch {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
    }

    const rows = messages().list(request.auth!.tenantId, { limit: limit + 1, cursor: decoded, from, to, subject });
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      messages: page.map((row) => ({
        id: row.id,
        envelopeFrom: row.envelope_from,
        envelopeTo: row.envelope_to,
        recipientDomain: row.recipient_domain,
        subject: row.subject,
        fromAddr: row.from_addr,
        fromName: row.from_name,
        receivedAt: row.received_at,
        sizeBytes: row.size_bytes,
        snippet: row.snippet,
        status: row.status,
        createdAt: row.created_at,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({ receivedAt: last.received_at, id: last.id }) : null,
    };
  });

  app.get("/v1/messages/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = findOwned(request.auth!.tenantId, id);
    if (!row) return reply.code(404).send({ error: "message_not_found" });

    const attachmentRows = app.deps.db
      .prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY part_index")
      .all(id) as AttachmentRow[];

    return {
      message: {
        id: row.id,
        envelopeFrom: row.envelope_from,
        envelopeTo: row.envelope_to,
        recipientDomain: row.recipient_domain,
        messageIdHeader: row.message_id_header,
        subject: row.subject,
        fromAddr: row.from_addr,
        fromName: row.from_name,
        to: recipients(row.id, "to"),
        cc: recipients(row.id, "cc"),
        receivedAt: row.received_at,
        sizeBytes: row.size_bytes,
        snippet: row.snippet,
        bodyText: row.body_text,
        hasHtml: row.html_path !== null,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
        attachments: attachmentRows.map(toAttachment),
      },
    };
  });

  app.get("/v1/messages/:id/raw", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = findOwned(request.auth!.tenantId, id);
    if (!row) return reply.code(404).send({ error: "message_not_found" });
    const bytes = await app.deps.storage.read(row.raw_path).catch(() => undefined);
    if (!bytes) return reply.code(404).send({ error: "raw_not_found" });
    return reply
      .header("content-type", "message/rfc822")
      .header("content-disposition", contentDisposition(`${row.id}.eml`))
      .header("x-content-type-options", "nosniff")
      .send(bytes);
  });

  app.get("/v1/messages/:id/attachments/:attachmentId", async (request, reply) => {
    const { id, attachmentId } = z.object({ id: z.string(), attachmentId: z.string() }).parse(request.params);
    const attachment = findAttachment(request.auth!.tenantId, id, attachmentId);
    if (!attachment) return reply.code(404).send({ error: "attachment_not_found" });
    const bytes = await app.deps.storage.read(attachment.path).catch(() => undefined);
    if (!bytes) return reply.code(404).send({ error: "attachment_not_found" });
    return reply
      .header("content-type", attachment.content_type || "application/octet-stream")
      .header("content-disposition", contentDisposition(attachment.filename))
      .header("x-content-type-options", "nosniff")
      .send(bytes);
  });

  app.delete("/v1/messages/:id", { preHandler: guard.requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const tenantId = request.auth!.tenantId;
    const row = findOwned(tenantId, id);
    if (!row) return reply.code(404).send({ error: "message_not_found" });

    const attachmentRows = app.deps.db.prepare("SELECT path FROM attachments WHERE message_id = ?").all(id) as Array<{
      path: string;
    }>;
    const files = [row.raw_path, ...attachmentRows.map((attachment) => attachment.path)];
    if (row.html_path) files.push(row.html_path);

    messages().deleteHard(row.id);
    for (const file of files) {
      await app.deps.storage.delete(file).catch(() => undefined);
    }
    return reply.code(204).send();
  });
};