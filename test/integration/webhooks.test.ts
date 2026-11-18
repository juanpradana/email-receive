import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateApiKey } from "../../src/auth/apiKey.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createApiKeysRepo } from "../../src/db/repo/apiKeys.js";
import { createMessagesRepo } from "../../src/db/repo/messages.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import { loadConfig } from "../../src/config.js";
import { createLocalStorage } from "../../src/services/storage.js";
import { deliverPending, enqueueMessageWebhooks } from "../../src/services/webhooks.js";

let root: string;
let db: Database.Database;
let app: ReturnType<typeof buildApp>;
let storage: ReturnType<typeof createLocalStorage>;
let tenantId: string;

function createTenant(name: string): string {
  return createTenantsRepo(db).createTenant(name).id;
}

function createKey(id: string, scope: "read" | "admin"): string {
  const generated = generateApiKey();
  createApiKeysRepo(db).create({
    tenantId: id,
    name: `${scope} key`,
    prefix: generated.prefix,
    keyHash: generated.hash,
    scopes: [scope],
  });
  return generated.plaintext;
}

function insertEndpoint(id: string, url: string) {
  db.prepare(
    `INSERT INTO webhook_endpoints (id, tenant_id, url, secret, events_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, tenantId, url, "s".repeat(32), JSON.stringify(["message.received"]), new Date().toISOString());
}

function insertMessage(id: string): string {
  const rawPath = path.join(root, `${id}.eml`);
  const messages = createMessagesRepo(db);
  messages.insert({
    id,
    tenantId,
    envelopeFrom: "sender@example.test",
    envelopeTo: "inbox@example.test",
    recipientDomain: "example.test",
    sha256: id,
    receivedAt: new Date().toISOString(),
    sizeBytes: 10,
    rawPath,
  });
  messages.markStored(tenantId, id, {
    subject: "Hi",
    fromAddr: "sender@example.test",
    fromName: "Sender",
    bodyText: "Hello there",
    snippet: "Hello there",
    htmlPath: null,
    messageIdHeader: "<m@example.test>",
  });
  return id;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "email-receive-webhooks-"));
  db = openDb(path.join(root, "test.db"));
  migrate(db);
  storage = createLocalStorage(root);
  app = buildApp({
    config: loadConfig({
      INGEST_HMAC_SECRET: "s".repeat(32),
      ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
      DATA_DIR: root,
    }),
    db,
    storage,
  });
  tenantId = createTenant("Acme");
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("webhook delivery", () => {
  it("delivers on success and marks success", async () => {
    insertEndpoint("hook-1", "https://hooks.example.test/inbound");
    const messageId = insertMessage("msg-1");
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    enqueueMessageWebhooks(db, tenantId, messageId);
    const delivered = await deliverPending(db, 10, { allowPrivate: true });

    expect(delivered).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.test/inbound");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-webhook-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers["x-webhook-event"]).toBe("message.received");
    expect(JSON.parse(String(init.body)).message.id).toBe("msg-1");

    const row = db.prepare("SELECT status, attempts FROM webhook_deliveries").get() as { status: string; attempts: number };
    expect(row).toEqual({ status: "success", attempts: 1 });
  });

  it("does not enqueue when the tenant has no endpoints", () => {
    insertMessage("msg-2");
    enqueueMessageWebhooks(db, tenantId, "msg-2");
    expect(db.prepare("SELECT count(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 0 });
  });

  it("retries a 500 and then succeeds", async () => {
    insertEndpoint("hook-2", "https://hooks.example.test/inbound");
    const messageId = insertMessage("msg-3");
    const responses = [new Response("boom", { status: 500 }), new Response("ok", { status: 200 })];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);

    enqueueMessageWebhooks(db, tenantId, messageId);
    await deliverPending(db, 10, { allowPrivate: true });
    let row = db.prepare("SELECT status, attempts, next_attempt_at FROM webhook_deliveries").get() as {
      status: string;
      attempts: number;
      next_attempt_at: string;
    };
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);

    db.prepare("UPDATE webhook_deliveries SET next_attempt_at = ?").run(new Date(Date.now() - 1000).toISOString());
    await deliverPending(db, 10, { allowPrivate: true });
    row = db.prepare("SELECT status, attempts FROM webhook_deliveries").get() as {
      status: string;
      attempts: number;
    } & { next_attempt_at: string };
    expect(row.status).toBe("success");
    expect(row.attempts).toBe(2);
  });

  it("dies after max attempts", async () => {
    insertEndpoint("hook-3", "https://hooks.example.test/inbound");
    const messageId = insertMessage("msg-4");
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    enqueueMessageWebhooks(db, tenantId, messageId);
    for (let i = 0; i < 3; i += 1) {
      db.prepare("UPDATE webhook_deliveries SET next_attempt_at = ?").run(new Date(Date.now() - 1000).toISOString());
      await deliverPending(db, 10, { allowPrivate: true, maxAttempts: 3 });
    }

    const row = db.prepare("SELECT status, attempts FROM webhook_deliveries").get() as { status: string; attempts: number };
    expect(row).toEqual({ status: "dead", attempts: 3 });
  });

  it("does not fail the stored message when webhook fails", async () => {
    insertEndpoint("hook-4", "https://hooks.example.test/inbound");
    const messageId = insertMessage("msg-5");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    enqueueMessageWebhooks(db, tenantId, messageId);
    await deliverPending(db, 10, { allowPrivate: true });

    const message = createMessagesRepo(db).findById(tenantId, messageId);
    expect(message?.status).toBe("stored");
  });

  it("refuses to deliver to a private address", async () => {
    const privateEndpoint = db.prepare(
      `INSERT INTO webhook_endpoints (id, tenant_id, url, secret, events_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    privateEndpoint.run(
      "hook-5",
      tenantId,
      "https://127.0.0.1/hook",
      "s".repeat(32),
      JSON.stringify(["message.received"]),
      new Date().toISOString(),
    );
    const messageId = insertMessage("msg-6");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    enqueueMessageWebhooks(db, tenantId, messageId);
    // Delivery uses the production guard (private targets disallowed) regardless of the test config.
    await deliverPending(db, 10, { allowPrivate: false });

    expect(fetchMock).not.toHaveBeenCalled();
    const row = db.prepare("SELECT status, last_error FROM webhook_deliveries").get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe("pending");
    expect(row.last_error).toMatch(/private/i);
  });
});

describe("webhook management routes", () => {
  it("creates, lists, and deletes endpoints for the authenticated tenant only", async () => {
    const key = createKey(tenantId, "admin");
    const created = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${key}` },
      payload: { url: "https://hooks.example.test/inbound", events: ["message.received"] },
    });
    expect(created.statusCode).toBe(201);
    const endpoint = created.json().endpoint as { id: string; secret: string };
    expect(endpoint.secret).toMatch(/^whsec_/);

    const other = createTenant("Other");
    const otherKey = createKey(other, "admin");
    const otherList = await app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization: `Bearer ${otherKey}` } });
    expect(otherList.json().endpoints).toEqual([]);

    const list = await app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization: `Bearer ${key}` } });
    expect(list.json().endpoints).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain(endpoint.secret);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/${endpoint.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(removed.statusCode).toBe(204);
  });

  it("rejects a non-admin key and an unsafe URL", async () => {
    const readKey = createKey(tenantId, "read");
    const denied = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${readKey}` },
      payload: { url: "https://hooks.example.test/inbound", events: ["message.received"] },
    });
    expect(denied.statusCode).toBe(403);

    const adminKey = createKey(tenantId, "admin");
    const unsafe = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { url: "https://127.0.0.1/hook", events: ["message.received"] },
    });
    expect(unsafe.statusCode).toBe(400);
  });

  it("redelivers a message to the tenant's endpoints", async () => {
    const key = createKey(tenantId, "admin");
    insertEndpoint("hook-6", "https://hooks.example.test/inbound");
    const messageId = insertMessage("msg-7");
    const response = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/redeliver`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(202);
    expect(db.prepare("SELECT count(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 1 });
  });
});