import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/client.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import { createApiKeysRepo } from "../../src/db/repo/apiKeys.js";
import { createMessagesRepo } from "../../src/db/repo/messages.js";

let db: Database.Database;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const messageRow = (tenantId: string, overrides: Record<string, unknown> = {}) => ({
  id: `msg-${Math.random().toString(36).slice(2)}`,
  tenantId,
  envelopeFrom: "sender@example.test",
  envelopeTo: "inbox@mail.acme.test",
  recipientDomain: "mail.acme.test",
  messageIdHeader: "<abc@example.test>",
  sha256: "f".repeat(64),
  subject: "Hello",
  fromAddr: "sender@example.test",
  fromName: "Sender",
  receivedAt: "2026-11-18T10:00:00.000Z",
  sizeBytes: 128,
  rawPath: "raw/x.eml",
  status: "pending" as const,
  createdAt: "2026-11-18T10:00:00.000Z",
  ...overrides,
});

describe("tenants repository", () => {
  it("resolves tenant by domain", () => {
    const tenants = createTenantsRepo(db);
    const tenant = tenants.createTenant("Acme");
    tenants.addDomain(tenant.id, "mail.acme.test");
    expect(tenants.findByDomain("mail.acme.test")?.id).toBe(tenant.id);
    expect(tenants.findByDomain("MAIL.ACME.TEST")?.id).toBe(tenant.id);
  });

  it("rejects duplicate domains", () => {
    const tenants = createTenantsRepo(db);
    const a = tenants.createTenant("Acme");
    const b = tenants.createTenant("Other");
    tenants.addDomain(a.id, "mail.acme.test");
    expect(() => tenants.addDomain(b.id, "mail.acme.test")).toThrow();
  });
});

describe("messages repository", () => {
  it("finds a message only within its tenant", () => {
    const tenants = createTenantsRepo(db);
    const messages = createMessagesRepo(db);
    const a = tenants.createTenant("Acme");
    const b = tenants.createTenant("Other");
    const row = messageRow(a.id);
    messages.insert(row);
    expect(messages.findById(a.id, row.id)?.id).toBe(row.id);
    expect(messages.findById(b.id, row.id)).toBeUndefined();
  });

  it("finds duplicates only inside the dedupe window", () => {
    const tenants = createTenantsRepo(db);
    const messages = createMessagesRepo(db);
    const tenant = tenants.createTenant("Acme");
    const row = messageRow(tenant.id);
    messages.insert(row);
    expect(messages.findDuplicate(tenant.id, row.sha256, "2026-11-18T00:00:00.000Z")?.id).toBe(row.id);
    expect(messages.findDuplicate(tenant.id, row.sha256, "2026-11-19T00:00:00.000Z")).toBeUndefined();
  });

  it("pages by received_at and id with a stable cursor", () => {
    const tenants = createTenantsRepo(db);
    const messages = createMessagesRepo(db);
    const tenant = tenants.createTenant("Acme");
    for (const suffix of ["b", "a", "c"]) {
      messages.insert(
        messageRow(tenant.id, {
          id: suffix,
          receivedAt: "2026-11-18T10:00:00.000Z",
        }),
      );
    }
    const first = messages.list(tenant.id, { limit: 2 });
    expect(first.map((m) => m.id)).toEqual(["c", "b"]);
    const second = messages.list(tenant.id, {
      limit: 2,
      cursor: { receivedAt: first[1]!.received_at, id: first[1]!.id },
    });
    expect(second.map((m) => m.id)).toEqual(["a"]);
  });

  it("excludes soft-deleted messages", () => {
    const tenants = createTenantsRepo(db);
    const messages = createMessagesRepo(db);
    const tenant = tenants.createTenant("Acme");
    const row = messageRow(tenant.id);
    messages.insert(row);
    messages.softDelete(tenant.id, row.id);
    expect(messages.findById(tenant.id, row.id)).toBeUndefined();
    expect(messages.list(tenant.id, {})).toHaveLength(0);
  });
});