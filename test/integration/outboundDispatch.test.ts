import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverOutboundPending } from "../../src/services/outbound.js";
import { createOutboundDeliveriesRepo, createOutboundRepo } from "../../src/db/repo/outbound.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import type { MailProvider, MailProviderResult } from "../../src/services/mail/provider.js";

let db: Database.Database;
let tenantId: string;
let provider: MailProvider;
let results: MailProviderResult[];

function makeProvider() {
  return {
    async send() {
      const result = results.shift() ?? { accepted: false, error: "unexpected" };
      return result;
    },
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  const tenants = createTenantsRepo(db);
  tenantId = tenants.createTenant("Acme").id;
  tenants.addDomain(tenantId, "acme.test");
  results = [];
  provider = makeProvider();
});
afterEach(() => db.close());

describe("outbound dispatcher", () => {
  it("delivers a pending message and marks it sent", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    deliveries.create({ messageId: row.id, nextAttemptAt: new Date().toISOString() });

    results.push({ accepted: true, resendMessageId: "resend-1" });
    await deliverOutboundPending(db, provider, 10, new Date());

    const msg = outbound.findById(tenantId, row.id)!;
    expect(msg.status).toBe("sent");
    expect(msg.message_id).toBe("resend-1");
    const delivery = deliveries.findByMessage(row.id)!;
    expect(delivery.status).toBe("delivered");
  });

  it("retries transient failures up to 5 attempts then marks dead", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    deliveries.create({ messageId: row.id, nextAttemptAt: new Date().toISOString() });

    // 5 transient failures — dispatcher must NOT mark dead until attempt 5
    // (terminal OR MAX_ATTEMPTS).
    for (let i = 0; i < 4; i += 1) {
      results.push({ accepted: false, error: "503 service unavailable" });
    }
    results.push({ accepted: false, error: "503 service unavailable" }); // 5th = at MAX

    // Drive a synthetic clock forward past each backoff window.
    // After attempt 1: next is ~10s+; after 2: ~60s; after 3: ~5m; after 4: ~30m.
    let clock = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await deliverOutboundPending(db, provider, 10, new Date(clock));
      clock += 5 * 60 * 60 * 1000; // 5h covers every remaining backoff
    }
    // Now delivery is in_flight (attempted 4 times, not dead).
    // 5th attempt: MAX_ATTEMPTS → dead.
    await deliverOutboundPending(db, provider, 10, new Date(clock));
    clock += 5 * 60 * 60 * 1000;

    const delivery = deliveries.findByMessage(row.id)!;
    expect(delivery.status).toBe("dead");
    expect(delivery.attempts).toBe(5);
    expect(delivery.last_error).toContain("503");
  });

  it("marks a delivery dead immediately when the provider signals a terminal error", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    deliveries.create({ messageId: row.id, nextAttemptAt: new Date().toISOString() });

    results.push({ accepted: false, error: "invalid_domain", terminal: true });
    await deliverOutboundPending(db, provider, 10, new Date());

    const delivery = deliveries.findByMessage(row.id)!;
    expect(delivery.status).toBe("dead");
    expect(delivery.attempts).toBe(1);
    expect(delivery.last_error).toBe("invalid_domain");
  });

  it("uses the 10-second backoff slot for the first failed attempt", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    const start = new Date();
    deliveries.create({ messageId: row.id, nextAttemptAt: start.toISOString() });

    results.push({ accepted: false, error: "503" });
    await deliverOutboundPending(db, provider, 10, start);

    const delivery = deliveries.findByMessage(row.id)!;
    const nextTime = new Date(delivery.next_attempt_at).getTime();
    // Next attempt should be 10s + jitter (up to 1s) after the start
    const deltaMs = nextTime - start.getTime();
    expect(deltaMs).toBeGreaterThanOrEqual(10_000);
    expect(deltaMs).toBeLessThanOrEqual(11_000);
  });

  it("does not delete the outbound message when the provider fails", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    deliveries.create({ messageId: row.id, nextAttemptAt: new Date().toISOString() });

    results.push({ accepted: false, error: "invalid_from" });
    await deliverOutboundPending(db, provider, 10, new Date());

    const msg = outbound.findById(tenantId, row.id)!;
    expect(msg.status).toBe("failed");
    expect(msg.error).toContain("invalid_from");
  });

  it("uses exponential backoff with jitter between attempts", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    deliveries.create({ messageId: row.id, nextAttemptAt: new Date().toISOString() });

    results.push({ accepted: false, error: "503" });
    await deliverOutboundPending(db, provider, 10, new Date());

    const delivery = deliveries.findByMessage(row.id)!;
    expect(delivery.next_attempt_at).not.toBe(new Date().toISOString());
    // next attempt should be in the future
    expect(new Date(delivery.next_attempt_at).getTime()).toBeGreaterThan(new Date().getTime());
  });

  it("skips deliveries that are not yet due", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const row = outbound.insert({
      tenantId,
      fromAddr: "me@acme.test",
      to: ["a@b.test"],
      subject: "hi",
      text: "body",
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    deliveries.create({ messageId: row.id, nextAttemptAt: future });

    results.push({ accepted: true, resendMessageId: "r1" });
    await deliverOutboundPending(db, provider, 10, new Date());

    expect(results.length).toBe(1); // no call made
    const msg = outbound.findById(tenantId, row.id)!;
    expect(msg.status).toBe("pending");
  });

  it("processes up to the batch limit", async () => {
    const outbound = createOutboundRepo(db);
    const deliveries = createOutboundDeliveriesRepo(db);
    const due = [];
    for (let i = 0; i < 15; i += 1) {
      const row = outbound.insert({
        tenantId,
        fromAddr: "me@acme.test",
        to: [`a${i}@b.test`],
        subject: `hi ${i}`,
        text: "body",
      });
      deliveries.create({ messageId: row.id, nextAttemptAt: new Date().toISOString() });
      due.push(row);
    }
    for (let i = 0; i < 15; i += 1) results.push({ accepted: true, resendMessageId: `r${i}` });

    await deliverOutboundPending(db, provider, 10, new Date());

    // Only 10 should be processed due to the batch limit
    let sent = 0;
    for (const row of due) {
      if (outbound.findById(tenantId, row.id)!.status === "sent") sent += 1;
    }
    expect(sent).toBe(10);
  });
});