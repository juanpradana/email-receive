import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createOutboundDeliveriesRepo, createOutboundRepo } from "../../src/db/repo/outbound.js";
import { createTenantSmtpConfigsRepo } from "../../src/db/repo/tenantSmtpConfigs.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";

let db: Database.Database;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
afterEach(() => db.close());

function newTenant(name = "Acme"): string {
  return createTenantsRepo(db).createTenant(name).id;
}

const outbound = (tenantId: string, overrides: Record<string, unknown> = {}) => ({
  tenantId,
  fromAddr: "me@acme.test",
  to: ["friend@example.test"],
  subject: "Hello",
  text: "Hi there",
  createdAt: "2026-11-18T10:00:00.000Z",
  ...overrides,
});

describe("outbound schema", () => {
  it("creates the outbound tables and cascades tenant deletes", () => {
    const tenantId = newTenant();
    const repo = createOutboundRepo(db);
    const row = repo.insert(outbound(tenantId));
    createOutboundDeliveriesRepo(db).create({ messageId: row.id, nextAttemptAt: "2026-11-18T10:00:00.000Z" });

    db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);

    expect(db.prepare("SELECT count(*) AS n FROM outbound_messages").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM outbound_deliveries").get()).toEqual({ n: 0 });
  });

  it("stays idempotent when migrate runs twice", () => {
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM outbound_messages").get()).toEqual({ n: 0 });
  });
});

describe("outbound repository", () => {
  it("inserts a pending message with JSON address lists", () => {
    const tenantId = newTenant();
    const row = createOutboundRepo(db).insert(
      outbound(tenantId, { cc: ["cc@example.test"], bcc: ["bcc@example.test"] }),
    );

    expect(row.status).toBe("pending");
    expect(row.from_addr).toBe("me@acme.test");
    expect(JSON.parse(row.to_json)).toEqual(["friend@example.test"]);
    expect(JSON.parse(row.cc_json)).toEqual(["cc@example.test"]);
    expect(JSON.parse(row.bcc_json)).toEqual(["bcc@example.test"]);
    expect(row.created_at).toBe("2026-11-18T10:00:00.000Z");
  });

  it("marks a message sent with its provider id and delivered timestamp", () => {
    const tenantId = newTenant();
    const repo = createOutboundRepo(db);
    const row = repo.insert(outbound(tenantId));

    repo.markSent(row.id, "resend-1", "2026-11-18T10:00:05.000Z");

    const found = repo.findById(tenantId, row.id)!;
    expect(found.status).toBe("sent");
    expect(found.message_id).toBe("resend-1");
    expect(found.delivered_at).toBe("2026-11-18T10:00:05.000Z");
    expect(found.error).toBeNull();
  });

  it("marks a message bounced and keeps the provider error", () => {
    const tenantId = newTenant();
    const repo = createOutboundRepo(db);
    const row = repo.insert(outbound(tenantId));

    repo.markBounced(row.id, "invalid_recipient");

    const found = repo.findById(tenantId, row.id)!;
    expect(found.status).toBe("bounced");
    expect(found.error).toBe("invalid_recipient");
  });

  it("marks a message failed without losing the row", () => {
    const tenantId = newTenant();
    const repo = createOutboundRepo(db);
    const row = repo.insert(outbound(tenantId));

    repo.markFailed(row.id, "provider exploded");

    expect(repo.findById(tenantId, row.id)).toMatchObject({ status: "failed", error: "provider exploded" });
  });

  it("lists newest first, filtered by tenant, status and soft-delete", () => {
    const tenantId = newTenant("Acme");
    const otherId = newTenant("Other");
    const repo = createOutboundRepo(db);
    const older = repo.insert(outbound(tenantId, { createdAt: "2026-11-18T09:00:00.000Z" }));
    const newer = repo.insert(outbound(tenantId, { createdAt: "2026-11-18T11:00:00.000Z" }));
    repo.insert(outbound(otherId, { createdAt: "2026-11-18T12:00:00.000Z" }));
    repo.markSent(newer.id, "resend-2", "2026-11-18T11:00:05.000Z");

    expect(repo.listByTenant(tenantId).map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(repo.listByTenant(tenantId, { status: "pending" }).map((row) => row.id)).toEqual([older.id]);

    repo.softDelete(tenantId, older.id);
    expect(repo.listByTenant(tenantId).map((row) => row.id)).toEqual([newer.id]);
    expect(repo.findById(tenantId, older.id)).toBeUndefined();
  });

  it("does not expose another tenant's message", () => {
    const tenantId = newTenant("Acme");
    const otherId = newTenant("Other");
    const row = createOutboundRepo(db).insert(outbound(tenantId));

    expect(createOutboundRepo(db).findById(otherId, row.id)).toBeUndefined();
  });
});

describe("outbound deliveries repository", () => {
  it("finds only due pending deliveries", () => {
    const tenantId = newTenant();
    const messages = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const due = messages.insert(outbound(tenantId));
    const future = messages.insert(outbound(tenantId));
    const sent = messages.insert(outbound(tenantId));

    deliveries.create({ messageId: due.id, nextAttemptAt: "2026-11-18T10:00:00.000Z" });
    deliveries.create({ messageId: future.id, nextAttemptAt: "2026-11-18T12:00:00.000Z" });
    const done = deliveries.create({ messageId: sent.id, nextAttemptAt: "2026-11-18T10:00:00.000Z" });
    deliveries.markDelivered(done.id, "resend-3");

    const pending = deliveries.findDue("2026-11-18T11:00:00.000Z", 10);
    expect(pending.map((row) => row.message_id)).toEqual([due.id]);
  });

  it("records retry attempts, failures and dead state", () => {
    const tenantId = newTenant();
    const row = createOutboundRepo(db).insert(outbound(tenantId));
    const deliveries = createOutboundDeliveriesRepo(db);
    const delivery = deliveries.create({ messageId: row.id, nextAttemptAt: "2026-11-18T10:00:00.000Z" });

    deliveries.markAttempt(delivery.id, 1, "provider timeout", "2026-11-18T10:00:10.000Z");
    let found = deliveries.findByMessage(row.id)!;
    expect(found).toMatchObject({ status: "pending", attempts: 1, last_error: "provider timeout" });
    expect(found.next_attempt_at).toBe("2026-11-18T10:00:10.000Z");

    deliveries.markDead(delivery.id, 5, "still failing");
    found = deliveries.findByMessage(row.id)!;
    expect(found).toMatchObject({ status: "dead", attempts: 5, last_error: "still failing" });
  });
});

describe("tenant smtp configs repository", () => {
  it("creates a default config on first use and keeps it", () => {
    const tenantId = newTenant();
    const configs = createTenantSmtpConfigsRepo(db);
    const first = configs.ensure(tenantId, { hourlyLimit: 10, now: "2026-11-18T10:00:00.000Z" });
    const second = configs.ensure(tenantId, { hourlyLimit: 99, now: "2026-11-18T10:30:00.000Z" });

    expect(first).toMatchObject({ provider: "resend", hourly_limit: 10, hourly_used: 0 });
    expect(second.tenant_id).toBe(first.tenant_id);
    expect(second.hourly_limit).toBe(10);
  });

  it("counts usage inside the hour and resets in a new hour", () => {
    const tenantId = newTenant();
    const configs = createTenantSmtpConfigsRepo(db);

    expect(configs.consume(tenantId, { hourlyLimit: 2, now: "2026-11-18T10:05:00.000Z" })).toBe(true);
    expect(configs.consume(tenantId, { hourlyLimit: 2, now: "2026-11-18T10:06:00.000Z" })).toBe(true);
    expect(configs.consume(tenantId, { hourlyLimit: 2, now: "2026-11-18T10:07:00.000Z" })).toBe(false);
    expect(configs.find(tenantId)!.hourly_used).toBe(2);

    expect(configs.consume(tenantId, { hourlyLimit: 2, now: "2026-11-18T11:00:01.000Z" })).toBe(true);
    expect(configs.find(tenantId)!.hourly_used).toBe(1);
  });

  it("keeps counters isolated per tenant", () => {
    const a = newTenant("Acme");
    const b = newTenant("Other");
    const configs = createTenantSmtpConfigsRepo(db);

    for (let i = 0; i < 2; i += 1) {
      expect(configs.consume(a, { hourlyLimit: 2, now: "2026-11-18T10:05:00.000Z" })).toBe(true);
    }
    expect(configs.consume(a, { hourlyLimit: 2, now: "2026-11-18T10:06:00.000Z" })).toBe(false);
    expect(configs.consume(b, { hourlyLimit: 2, now: "2026-11-18T10:06:00.000Z" })).toBe(true);
  });
});
