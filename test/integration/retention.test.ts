import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createMessagesRepo } from "../../src/db/repo/messages.js";
import { createTenantSmtpConfigsRepo } from "../../src/db/repo/tenantSmtpConfigs.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import { createLocalStorage } from "../../src/services/storage.js";
import { purgeExpired, resetHourlyUsage } from "../../src/jobs/retention.js";

let root: string;
let db: ReturnType<typeof openDb>;
let storage: ReturnType<typeof createLocalStorage>;
let tenantId: string;
const now = new Date("2026-11-18T12:00:00.000Z");

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "email-receive-retention-"));
  db = openDb(path.join(root, "test.db"));
  migrate(db);
  storage = createLocalStorage(root);
  tenantId = createTenantsRepo(db).createTenant("Retention test").id;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function addMessage(id: string, receivedAt: string) {
  const rawPath = path.join(root, `${id}.eml`);
  writeFileSync(rawPath, `raw ${id}`);
  const message = createMessagesRepo(db).insert({
    id,
    tenantId,
    envelopeFrom: "sender@example.test",
    envelopeTo: "inbox@example.test",
    recipientDomain: "example.test",
    sha256: id,
    receivedAt,
    sizeBytes: Buffer.byteLength(`raw ${id}`),
    rawPath,
  });
  const htmlPath = await storage.putHtml(id, `<p>${id}</p>`);
  const attachmentPath = await storage.putAttachment(id, 0, `${id}.txt`, Buffer.from(`attachment ${id}`));
  db.prepare("UPDATE messages SET html_path = ? WHERE tenant_id = ? AND id = ?").run(htmlPath, tenantId, id);
  db.prepare(
    `INSERT INTO attachments (id, message_id, part_index, filename, content_type, size_bytes, path)
     VALUES (?, ?, 0, ?, 'text/plain', ?, ?)`,
  ).run(`att-${id}`, id, `${id}.txt`, Buffer.byteLength(`attachment ${id}`), attachmentPath);
  return { message, rawPath, htmlPath, attachmentPath };
}

describe("message retention", () => {
  it("removes rows and files older than RETENTION_DAYS", async () => {
    const expired = await addMessage("expired", "2026-11-16T11:59:59.999Z");
    const current = await addMessage("current", "2026-11-16T12:00:00.000Z");

    const removed = await purgeExpired(db, storage, 2, now);

    expect(removed).toBe(1);
    expect(createMessagesRepo(db).findById(tenantId, "expired")).toBeUndefined();
    expect(createMessagesRepo(db).findById(tenantId, "current")).toBeDefined();
    expect(existsSync(expired.rawPath)).toBe(false);
    expect(existsSync(expired.htmlPath)).toBe(false);
    expect(existsSync(expired.attachmentPath)).toBe(false);
    expect(existsSync(current.rawPath)).toBe(true);
    expect(existsSync(current.htmlPath)).toBe(true);
    expect(existsSync(current.attachmentPath)).toBe(true);
  });

  it("keeps everything when RETENTION_DAYS=0", async () => {
    const old = await addMessage("forever", "2000-01-01T00:00:00.000Z");

    const removed = await purgeExpired(db, storage, 0, now);

    expect(removed).toBe(0);
    expect(createMessagesRepo(db).findById(tenantId, "forever")).toBeDefined();
    expect(existsSync(old.rawPath)).toBe(true);
    expect(existsSync(old.htmlPath)).toBe(true);
    expect(existsSync(old.attachmentPath)).toBe(true);
  });
});

describe("outbound hourly usage reset", () => {
  it("clears last hour's counter and leaves the current hour alone", () => {
    const configs = createTenantSmtpConfigsRepo(db);
    configs.consume(tenantId, { hourlyLimit: 5, now: "2026-11-18T10:05:00.000Z" });
    configs.consume(tenantId, { hourlyLimit: 5, now: "2026-11-18T10:06:00.000Z" });
    expect(configs.find(tenantId)!.hourly_used).toBe(2);

    resetHourlyUsage(db, new Date("2026-11-18T10:30:00.000Z"));
    expect(configs.find(tenantId)!.hourly_used).toBe(2);

    resetHourlyUsage(db, new Date("2026-11-18T11:00:00.000Z"));
    expect(configs.find(tenantId)!.hourly_used).toBe(0);
    expect(configs.find(tenantId)!.hour_started).toBe("2026-11-18T11:00:00.000Z");
  });
});
