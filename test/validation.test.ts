import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { generateApiKey, createAdminAuthGuard } from "../src/auth/apiKey.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createApiKeysRepo } from "../src/db/repo/apiKeys.js";
import { createMessagesRepo } from "../src/db/repo/messages.js";
import { createTenantsRepo } from "../src/db/repo/tenants.js";
import type { MailProvider } from "../src/services/mail/provider.js";

let db: Database.Database;
let app: ReturnType<typeof buildApp>;
let provider: MailProvider;

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

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  provider = {
    async send() {
      return { accepted: true, resendMessageId: "r-1" };
    },
  };
  app = makeApp();
});
afterEach(async () => {
  await app.close();
  db.close();
});

const body = (overrides: Record<string, unknown> = {}) => ({
  fromAddr: "me@acme.test",
  to: ["friend@example.test"],
  subject: "Hello",
  text: "Hi there",
  ...overrides,
});

describe("outbound recipient validation", () => {
  it("rejects mailto: scheme addresses", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["mailto:friend@example.test"] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("rejects private IPv4 loopback addresses", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@127.0.0.1"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects private IPv4 RFC1918 addresses", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@192.168.1.50"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects private IPv4 10.x addresses", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@10.0.0.1"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects private IPv6 loopback", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@[::1]"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects private IPv6 fc00::/8 range", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@[fd00::1]"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts public IPv4 addresses", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@8.8.8.8"] }),
    });
    expect(res.statusCode).toBe(202);
  });

  it("accepts public IPv6 addresses", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to: ["user@[2606:4700:4700::1111]"] }),
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects 51+ recipients on outbound (over the 50 cap)", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const to = Array.from({ length: 51 }, (_, i) => `u${i}@example.test`);
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("reply aggregate recipient cap", () => {
  function storedMessage(tenantId: string): string {
    const id = "msg-reply-val";
    createMessagesRepo(db).insert({
      id,
      tenantId,
      envelopeFrom: "sender@external.test",
      envelopeTo: "me@acme.test",
      recipientDomain: "acme.test",
      sha256: "sha",
      receivedAt: "2026-11-18T10:00:00.000Z",
      sizeBytes: 10,
      rawPath: "raw/msg-reply-val.eml",
      status: "stored",
    });
    db.prepare("UPDATE messages SET subject = ?, from_addr = ?, body_text = ? WHERE id = ?").run(
      "Orig",
      "Sender <sender@external.test>",
      "body",
      id,
    );
    return id;
  }

  it("rejects 150 aggregate recipients on reply (50 to + 50 cc + 50 bcc)", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const messageId = storedMessage(tenant.id);
    const many = (prefix: string) =>
      Array.from({ length: 50 }, (_, i) => `${prefix}${i}@example.test`);

    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: { to: many("t"), cc: many("c"), bcc: many("b"), text: "x" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts up to 50 aggregate recipients on reply", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const messageId = storedMessage(tenant.id);
    const res = await app.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/reply`,
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: {
        to: Array.from({ length: 30 }, (_, i) => `t${i}@example.test`),
        cc: Array.from({ length: 15 }, (_, i) => `c${i}@example.test`),
        text: "ok",
      },
    });
    expect(res.statusCode).toBe(202);
  });
});