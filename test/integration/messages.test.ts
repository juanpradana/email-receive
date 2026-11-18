import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateApiKey } from "../../src/auth/apiKey.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createApiKeysRepo } from "../../src/db/repo/apiKeys.js";
import { createMessagesRepo } from "../../src/db/repo/messages.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import { loadConfig } from "../../src/config.js";
import { createLocalStorage } from "../../src/services/storage.js";
import { processPending } from "../../src/services/pipeline.js";

let root: string;
let db: Database.Database;
let app: ReturnType<typeof buildApp>;
let storage: ReturnType<typeof createLocalStorage>;
const adminToken = "admin-bootstrap-token";

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "email-receive-messages-"));
  db = openDb(path.join(root, "test.db"));
  migrate(db);
  storage = createLocalStorage(root);
  app = buildApp({
    config: loadConfig({
      INGEST_HMAC_SECRET: "s".repeat(32),
      ADMIN_BOOTSTRAP_TOKEN: adminToken,
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
      DATA_DIR: root,
    }),
    db,
    storage,
  });
});

function generateFor(tenantId: string, scope: "read" | "admin"): string {
  const generated = generateApiKey();
  createApiKeysRepo(db).create({
    tenantId,
    name: `${scope} key`,
    prefix: generated.prefix,
    keyHash: generated.hash,
    scopes: [scope],
  });
  return generated.plaintext;
}

async function createTenant(name: string, scope: "read" | "admin" = "read") {
  const tenant = createTenantsRepo(db).createTenant(name);
  return { id: tenant.id, key: generateFor(tenant.id, scope) };
}

function insertMessage(tenantId: string, id: string, receivedAt: string, text: string) {
  const rawPath = path.join(root, `${id}.eml`);
  const raw = Buffer.from(`From: sender@example.test\r\nTo: inbox@example.test\r\nSubject: ${id}\r\nContent-Type: text/plain\r\n\r\n${text}`);
  writeFileSync(rawPath, raw);
  return createMessagesRepo(db).insert({
    id,
    tenantId,
    envelopeFrom: "sender@example.test",
    envelopeTo: "inbox@example.test",
    recipientDomain: "example.test",
    sha256: id,
    receivedAt,
    sizeBytes: raw.length,
    rawPath,
  });
}

async function authorize(tenantId: string, key: string, url: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
}

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("message read API", () => {
  it("does not return another tenant's message", async () => {
    const alice = await createTenant("Alice");
    const bob = await createTenant("Bob");
    insertMessage(alice.id, "alice-msg", "2026-11-18T10:00:00.000Z", "secret");
    const response = await authorize(bob.id, bob.key, "/v1/messages/alice-msg");
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for another tenant's raw and attachment", async () => {
    const alice = await createTenant("Alice");
    const bob = await createTenant("Bob");
    const message = insertMessage(alice.id, "alice-msg", "2026-11-18T10:00:00.000Z", "secret");
    const attachmentPath = await storage.putAttachment(message.id, 0, "secret.txt", Buffer.from("private"));
    db.prepare(`INSERT INTO attachments (id, message_id, part_index, filename, content_type, size_bytes, path)
      VALUES ('att-1', ?, 0, 'secret.txt', 'text/plain', 7, ?)`).run(message.id, attachmentPath);

    const raw = await authorize(bob.id, bob.key, "/v1/messages/alice-msg/raw");
    const attachment = await authorize(bob.id, bob.key, "/v1/messages/alice-msg/attachments/att-1");
    expect(raw.statusCode).toBe(404);
    expect(attachment.statusCode).toBe(404);
  });

  it("orders by received_at desc with a stable cursor", async () => {
    const tenant = await createTenant("Alice");
    insertMessage(tenant.id, "m-a", "2026-11-18T10:00:00.000Z", "one");
    insertMessage(tenant.id, "m-b", "2026-11-18T10:00:00.000Z", "two");
    insertMessage(tenant.id, "m-c", "2026-11-18T11:00:00.000Z", "three");
    const first = await authorize(tenant.id, tenant.key, "/v1/messages?limit=2");
    expect(first.statusCode).toBe(200);
    expect(first.json().messages.map((m: { id: string }) => m.id)).toEqual(["m-c", "m-b"]);
    const cursor = first.json().nextCursor as string;
    const second = await authorize(tenant.id, tenant.key, `/v1/messages?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.json().messages.map((m: { id: string }) => m.id)).toEqual(["m-a"]);
  });

  it("keeps paging past a full page at the maximum limit", async () => {
    const tenant = await createTenant("Alice");
    for (let index = 0; index < 101; index += 1) {
      const stamp = new Date(Date.UTC(2026, 10, 18, 0, 0, 0) + index * 60_000).toISOString();
      insertMessage(tenant.id, `m-${index}`, stamp, `body ${index}`);
    }
    const first = await authorize(tenant.id, tenant.key, "/v1/messages?limit=100");
    expect(first.statusCode).toBe(200);
    expect(first.json().messages).toHaveLength(100);
    const cursor = first.json().nextCursor as string;
    expect(cursor).not.toBeNull();
    const second = await authorize(tenant.id, tenant.key, `/v1/messages?limit=100&cursor=${encodeURIComponent(cursor)}`);
    expect(second.json().messages.map((m: { id: string }) => m.id)).toEqual(["m-0"]);
    expect(second.json().nextCursor).toBeNull();
  });

  it("excludes soft-deleted messages", async () => {
    const tenant = await createTenant("Alice");
    insertMessage(tenant.id, "gone", "2026-11-18T10:00:00.000Z", "deleted");
    insertMessage(tenant.id, "alive", "2026-11-18T11:00:00.000Z", "active");
    createMessagesRepo(db).softDelete(tenant.id, "gone");
    const response = await authorize(tenant.id, tenant.key, "/v1/messages");
    expect(response.json().messages.map((m: { id: string }) => m.id)).toEqual(["alive"]);
  });

  it("stores parsed message content and attachments", async () => {
    const tenant = await createTenant("Alice");
    const fixture = readFileSync(path.join(process.cwd(), "test/fixtures/multipart-attachments.eml"));
    const rawPath = path.join(root, "with-attachments.eml");
    writeFileSync(rawPath, fixture);
    createMessagesRepo(db).insert({
      id: "parsed-message",
      tenantId: tenant.id,
      envelopeFrom: "sender@example.test",
      envelopeTo: "inbox@example.test",
      recipientDomain: "example.test",
      sha256: "parsed-sha",
      receivedAt: "2026-11-18T10:00:00.000Z",
      sizeBytes: fixture.length,
      rawPath,
    });

    const processed = await processPending(db, storage, 10);
    expect(processed).toBe(1);
    const stored = createMessagesRepo(db).findById(tenant.id, "parsed-message");
    expect(stored?.status).toBe("stored");
    expect(stored?.subject).toBe("Two files");
    expect(stored?.body_text).toContain("See attached.");

    const attachments = db
      .prepare("SELECT id, filename FROM attachments WHERE message_id = ? ORDER BY part_index")
      .all("parsed-message") as Array<{ id: string; filename: string }>;
    expect(attachments.map((row) => row.filename)).toEqual(["one.txt", "two.bin"]);

    const download = await authorize(tenant.id, tenant.key, `/v1/messages/parsed-message/attachments/${attachments[0]!.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("one file");
  });

  it("sends a non-Latin attachment filename without crashing the response", async () => {
    const tenant = await createTenant("Alice");
    const message = insertMessage(tenant.id, "cjk-msg", "2026-11-18T10:00:00.000Z", "body");
    const attachmentPath = await storage.putAttachment(message.id, 0, "laporan.txt", Buffer.from("isi"));
    db.prepare(`INSERT INTO attachments (id, message_id, part_index, filename, content_type, size_bytes, path)
      VALUES ('att-cjk', ?, 0, '日本語のレポート.pdf', 'application/pdf', 3, ?)`).run(message.id, attachmentPath);

    const response = await authorize(tenant.id, tenant.key, "/v1/messages/cjk-msg/attachments/att-cjk");
    expect(response.statusCode).toBe(200);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("日本語のレポート.pdf")}`);
    expect(disposition).toMatch(/filename="[\x20-\x7e]*"/);
  });

  it("keeps raw downloadable when parsing fails", async () => {
    const tenant = await createTenant("Alice");
    const parts = Array.from(
      { length: 51 },
      (_unused, index) =>
        `--many\r\nContent-Type: text/plain; name="f${index}.txt"\r\nContent-Disposition: attachment; filename="f${index}.txt"\r\n\r\nx\r\n`,
    ).join("");
    const raw = Buffer.from(
      `From: sender@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=many\r\n\r\n${parts}--many--\r\n`,
    );
    const rawPath = path.join(root, "broken.eml");
    writeFileSync(rawPath, raw);
    createMessagesRepo(db).insert({
      id: "bad-message",
      tenantId: tenant.id,
      envelopeFrom: "sender@example.test",
      envelopeTo: "inbox@example.test",
      recipientDomain: "example.test",
      sha256: "bad-sha",
      receivedAt: "2026-11-18T10:00:00.000Z",
      sizeBytes: raw.length,
      rawPath,
    });
    await processPending(db, storage, 10);
    const response = await authorize(tenant.id, tenant.key, "/v1/messages/bad-message/raw");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("attachment");
    const failed = createMessagesRepo(db).findById(tenant.id, "bad-message");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/attachment/i);
  });

  it("requires admin scope and the owning tenant to delete, then removes files", async () => {
    const regular = await createTenant("Alice");
    const otherAdmin = await createTenant("Other admin", "admin");
    const message = insertMessage(regular.id, "delete-me", "2026-11-18T10:00:00.000Z", "body");

    const denied = await app.inject({ method: "DELETE", url: "/v1/messages/delete-me", headers: { authorization: `Bearer ${regular.key}` } });
    expect(denied.statusCode).toBe(403);

    const crossTenant = await app.inject({ method: "DELETE", url: "/v1/messages/delete-me", headers: { authorization: `Bearer ${otherAdmin.key}` } });
    expect(crossTenant.statusCode).toBe(404);

    const adminKey = generateFor(regular.id, "admin");
    const deleted = await app.inject({ method: "DELETE", url: "/v1/messages/delete-me", headers: { authorization: `Bearer ${adminKey}` } });
    expect(deleted.statusCode).toBe(204);
    expect(createMessagesRepo(db).findById(regular.id, "delete-me")).toBeUndefined();
    expect(existsSync(message.raw_path)).toBe(false);
  });
});
