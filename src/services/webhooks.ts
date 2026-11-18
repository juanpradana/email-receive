import { createHmac, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { newId } from "../db/client.js";
import type { MessageRow } from "../db/repo/messages.js";
import { createMessagesRepo } from "../db/repo/messages.js";
import { assertSafeWebhookUrl, assertWebhookUrlShape } from "../lib/webhookUrl.js";

export const WEBHOOK_EVENT = "message.received";
export const WEBHOOK_TIMEOUT_MS = 10_000;
const BACKOFF_SECONDS = [10, 60, 300, 1800, 7200, 21_600, 86_400];
const BODY_TEXT_LIMIT = 20_000;

interface EndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  secret: string;
  events_json: string;
  active: number;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  message_id: string;
  event: string;
  payload_json: string;
  status: "pending" | "success" | "failed" | "dead";
  attempts: number;
  next_attempt_at: string;
}

export function signWebhook(secret: string, timestamp: number, rawBody: string | Buffer): string {
  const payload = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function backoffSeconds(attempts: number): number {
  const base = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!;
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.1)));
  return base + jitter;
}

function buildPayload(message: MessageRow, attachments: Array<{ id: string; part_index: number; filename: string; content_type: string; disposition: string | null; content_id: string | null; is_inline: number; size_bytes: number }>, publicBaseUrl: string) {
  return JSON.stringify({
    event: WEBHOOK_EVENT,
    message: {
      id: message.id,
      envelopeFrom: message.envelope_from,
      envelopeTo: message.envelope_to,
      recipientDomain: message.recipient_domain,
      messageId: message.message_id_header,
      subject: message.subject,
      fromAddr: message.from_addr,
      fromName: message.from_name,
      receivedAt: message.received_at,
      sizeBytes: message.size_bytes,
      snippet: message.snippet,
      bodyText: (message.body_text ?? "").slice(0, BODY_TEXT_LIMIT) || null,
      status: message.status,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        partIndex: attachment.part_index,
        filename: attachment.filename,
        contentType: attachment.content_type,
        disposition: attachment.disposition,
        contentId: attachment.content_id,
        isInline: attachment.is_inline === 1,
        sizeBytes: attachment.size_bytes,
        url: `${publicBaseUrl}/v1/messages/${message.id}/attachments/${attachment.id}`,
      })),
      rawUrl: `${publicBaseUrl}/v1/messages/${message.id}/raw`,
    },
  });
}

export function enqueueMessageWebhooks(db: Database.Database, tenantId: string, messageId: string, publicBaseUrl = ""): number {
  const endpoints = db
    .prepare("SELECT * FROM webhook_endpoints WHERE tenant_id = ? AND active = 1")
    .all(tenantId) as EndpointRow[];
  if (endpoints.length === 0) return 0;

  const message = createMessagesRepo(db).findById(tenantId, messageId);
  if (!message) return 0;

  const attachments = db
    .prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY part_index")
    .all(messageId) as Array<{
    id: string;
    part_index: number;
    filename: string;
    content_type: string;
    disposition: string | null;
    content_id: string | null;
    is_inline: number;
    size_bytes: number;
  }>;

  const payload = buildPayload(message, attachments, publicBaseUrl);
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO webhook_deliveries
       (id, endpoint_id, message_id, event, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  );

  let created = 0;
  for (const endpoint of endpoints) {
    const events = JSON.parse(endpoint.events_json) as string[];
    if (!events.includes(WEBHOOK_EVENT) && !events.includes("*")) continue;
    insert.run(newId(), endpoint.id, messageId, WEBHOOK_EVENT, payload, now, now, now);
    created += 1;
  }
  return created;
}

export interface DeliverOptions {
  allowPrivate?: boolean;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  now?: Date;
  publicBaseUrl?: string;
}

async function deliverOne(
  db: Database.Database,
  delivery: DeliveryRow,
  endpoint: EndpointRow,
  options: DeliverOptions,
): Promise<boolean> {
  const allowPrivate = options.allowPrivate ?? false;
  const maxAttempts = options.maxAttempts ?? 8;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    assertWebhookUrlShape(endpoint.url, allowPrivate);
    await assertSafeWebhookUrl(endpoint.url, allowPrivate, options.resolve);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = delivery.attempts + 1;
    db.prepare(
      `UPDATE webhook_deliveries SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      attempts,
      message,
      new Date((options.now ?? new Date()).getTime() + backoffSeconds(attempts) * 1000).toISOString(),
      new Date().toISOString(),
      delivery.id,
    );
    return false;
  }

  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const attempts = delivery.attempts + 1;

  try {
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "email-receive/1 webhook",
        "x-webhook-id": delivery.id,
        "x-webhook-event": delivery.event,
        "x-webhook-attempt": String(attempts),
        "x-webhook-signature": signWebhook(endpoint.secret, timestamp, delivery.payload_json),
      },
      body: delivery.payload_json,
    });

    if (response.ok) {
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE webhook_deliveries SET status = 'success', attempts = ?, response_status = ?, delivered_at = ?, updated_at = ?, last_error = NULL
         WHERE id = ?`,
      ).run(attempts, response.status, now, now, delivery.id);
      return true;
    }

    throw new Error(`Webhook returned HTTP ${response.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = attempts >= maxAttempts ? "dead" : "pending";
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      attempts,
      message.slice(0, 1000),
      new Date((options.now ?? new Date()).getTime() + backoffSeconds(attempts) * 1000).toISOString(),
      now,
      delivery.id,
    );
    return false;
  }
}

export async function deliverPending(db: Database.Database, limit: number, options: DeliverOptions = {}): Promise<number> {
  const due = db
    .prepare(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC LIMIT ?`,
    )
    .all((options.now ?? new Date()).toISOString(), limit) as DeliveryRow[];

  let delivered = 0;
  for (const delivery of due) {
    const endpoint = db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(delivery.endpoint_id) as
      | EndpointRow
      | undefined;
    if (!endpoint || endpoint.active !== 1) {
      db.prepare("UPDATE webhook_deliveries SET status = 'dead', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        delivery.id,
      );
      continue;
    }
    if (await deliverOne(db, delivery, endpoint, options)) delivered += 1;
  }
  return delivered;
}

export interface WebhookEndpointInput {
  url: string;
  events: string[];
}

export function createWebhooksRepo(db: Database.Database) {
  return {
    list(tenantId: string) {
      return db
        .prepare("SELECT * FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at ASC")
        .all(tenantId) as EndpointRow[];
    },
    find(tenantId: string, id: string) {
      return db.prepare("SELECT * FROM webhook_endpoints WHERE tenant_id = ? AND id = ?").get(tenantId, id) as
        | EndpointRow
        | undefined;
    },
    create(tenantId: string, input: WebhookEndpointInput) {
      const row = {
        id: newId(),
        tenant_id: tenantId,
        url: input.url,
        secret: generateWebhookSecret(),
        events_json: JSON.stringify(input.events),
        active: 1,
        created_at: new Date().toISOString(),
      };
      db.prepare(
        `INSERT INTO webhook_endpoints (id, tenant_id, url, secret, events_json, active, created_at)
         VALUES (@id, @tenant_id, @url, @secret, @events_json, @active, @created_at)`,
      ).run(row);
      return row;
    },
    remove(tenantId: string, id: string) {
      return (
        db.prepare("DELETE FROM webhook_endpoints WHERE tenant_id = ? AND id = ?").run(tenantId, id).changes > 0
      );
    },
    deliveries(tenantId: string, endpointId: string) {
      return db
        .prepare(
          `SELECT d.* FROM webhook_deliveries d
           JOIN webhook_endpoints e ON e.id = d.endpoint_id
           WHERE e.tenant_id = ? AND e.id = ?
           ORDER BY d.created_at DESC LIMIT 100`,
        )
        .all(tenantId, endpointId) as Array<DeliveryRow & { response_status: number | null; last_error: string | null; delivered_at: string | null; created_at: string }>;
    },
  };
}