import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateApiKey, createAdminAuthGuard } from "../../src/auth/apiKey.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createApiKeysRepo } from "../../src/db/repo/apiKeys.js";
import { createMessagesRepo } from "../../src/db/repo/messages.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import type { MailProvider } from "../../src/services/mail/provider.js";

let db: Database.Database;
let app: ReturnType<typeof buildApp>;
let provider: MailProvider;
let sent: Array<import("../../src/services/mail/provider.js").MailProviderInput>;

function makeApp() {
  const config = {
    ...loadConfig({
      INGEST_HMAC_SECRET: "a".repeat(32),
      ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
    }),
    resendApiKey: "test-key",
    outboundRateLimitPerHour: 10,
  };
  const adminAuthGuard = createAdminAuthGuard(db, config.adminBootstrapToken);
  return buildApp({
    config,
    db,
    storage: {} as never,
    mailProvider: provider,
    adminAuthGuard,
  });
}

function createTenant(name: string, ...domains: string[]): { id: string; key: string } {
  const tenants = createTenantsRepo(db);
  const tenant = tenants.createTenant(name);
  for (const domain of domains) tenants.addDomain(tenant.id, domain);
  const generated = generateApiKey();
  createApiKeysRepo(db).create({
    tenantId: tenant.id,
    name: "key",
    prefix: generated.prefix,
    keyHash: generated.hash,
    scopes: ["read", "admin"],
  });
  return { id: tenant.id, key: generated.plaintext };
}

/** Inserts a fully-stored inbound message owned by the tenant. */
function storedMessage(
  tenantId: string,
  overrides: Partial<{
    envelopeFrom: string;
    envelopeTo: string;
    messageIdHeader: string;
    subject: string;
    fromAddr: string | null;
  }>,
): string {
  const id = "msg-reply";
  createMessagesRepo(db).insert({
    id,
    tenantId,
    envelopeFrom: overrides.envelopeFrom ?? "sender@external.test",
    envelopeTo: overrides.envelopeTo ?? "me@acme.test",
    recipientDomain: "acme.test",
    sha256: "sha",
    receivedAt: "2026-11-18T10:00:00.000Z",
    sizeBytes: 10,
    rawPath: "raw/msg-reply.eml",
    status: "stored",
  });
  db.prepare(
    `UPDATE messages SET subject = ?, from_addr = ?, message_id_header = ?, body_text = ? WHERE id = ?`,
  ).run(
    overrides.subject ?? "Original subject",
    overrides.fromAddr === null ? null : (overrides.fromAddr ?? "Sender <sender@external.test>"),
    overrides.messageIdHeader ?? "<abc@example.test>",
    "original body",
    id,
  );
  return id;
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  sent = [];
  provider = {
    async send(input) {
      sent.push(input);
      return { accepted: true, resendMessageId: `r-${sent.length}` };
    },
  };
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe("POST /v1/messages/:id/reply", () => {
  it("composes a reply with In-Reply-To, References and Reply-To headers", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const messageId = storedMessage(tenant.id, { messageIdHeader: "<orig-123@acme.test>" });

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: { to: ["sender@external.test"], text: "thanks for your note" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);

    const input = sent[0]!;
    expect(input.fromAddr).toBe("me@acme.test");
    expect(input.headers?.["In-Reply-To"]).toBe("<orig-123@acme.test>");
    expect(input.headers?.["References"]).toBe("<orig-123@acme.test>");
    expect(input.headers?.["Reply-To"]).toBe("sender@external.test");
    expect(input.subject).toBe("Re: Original subject");
  });

  it("defaults the recipient to the original sender and subject to Re:", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const messageId = storedMessage(tenant.id, {});

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: { text: "re" },
    });

    expect(res.statusCode).toBe(202);
    const input = sent[0]!;
    expect(input.to).toEqual(["sender@external.test"]);
    expect(input.subject).toBe("Re: Original subject");
  });

  it("does not double the Re: prefix", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const messageId = storedMessage(tenant.id, { subject: "Re: Already prefixed" });

    await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: { text: "x" },
    });

    expect(sent[0]!.subject).toBe("Re: Already prefixed");
  });

  it("returns 404 for another tenant's message id", async () => {
    app = makeApp();
    const acme = createTenant("Acme", "acme.test");
    const other = createTenant("Other", "other.test");
    const messageId = storedMessage(acme.id, {});

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${other.key}` },
      payload: { text: "not yours" },
    });

    expect(res.statusCode).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("falls back to the tenant's own address when the original sender is missing", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const messageId = storedMessage(tenant.id, { envelopeFrom: "", fromAddr: null });

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: { text: "fallback" },
    });

    expect(res.statusCode).toBe(202);
    expect(sent[0]!.to).toEqual(["me@acme.test"]);
  });
});
