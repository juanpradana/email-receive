import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateApiKey, createAdminAuthGuard } from "../../src/auth/apiKey.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createApiKeysRepo } from "../../src/db/repo/apiKeys.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import type { MailProvider } from "../../src/services/mail/provider.js";

let db: Database.Database;
let app: ReturnType<typeof buildApp>;
let provider: MailProvider;
let sent: Array<{ fromAddr: string; to: string[]; subject: string }>;

function makeApp(hourlyLimit = 10) {
  const config = {
    ...loadConfig({
      INGEST_HMAC_SECRET: "a".repeat(32),
      ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
    }),
    resendApiKey: "test-key",
    outboundRateLimitPerHour: hourlyLimit,
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
  sent = [];
  provider = {
    async send(input) {
      sent.push({ fromAddr: input.fromAddr, to: input.to, subject: input.subject });
      return { accepted: true, resendMessageId: `r-${sent.length}` };
    },
  };
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

describe("POST /v1/outbound", () => {
  it("returns 401 without an api key", async () => {
    app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/outbound", payload: body() });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a read-only key", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const readOnly = generateApiKey();
    createApiKeysRepo(db).create({
      tenantId: tenant.id,
      name: "read",
      prefix: readOnly.prefix,
      keyHash: readOnly.hash,
      scopes: ["read"],
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${readOnly.plaintext}` },
      payload: body(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts a message and returns 202 with the provider id", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body(),
    });

    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json.accepted).toBe(true);
    expect(json.resendMessageId).toBe("r-1");
    expect(json.outboundId).toBeTruthy();
    expect(sent).toHaveLength(1);

    const row = db.prepare("SELECT * FROM outbound_messages WHERE id = ?").get(json.outboundId) as {
      status: string;
      from_addr: string;
    };
    expect(row.status).toBe("sent");
    expect(row.from_addr).toBe("me@acme.test");
  });

  it("rejects a From address outside the tenant's domains", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ fromAddr: "me@evil.test" }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("from_addr_not_allowed");
    expect(sent).toHaveLength(0);
  });

  it("does not let one tenant send from another tenant's domain", async () => {
    app = makeApp();
    const acme = createTenant("Acme", "acme.test");
    const other = createTenant("Other", "other.test");

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${other.key}` },
      payload: body({ fromAddr: "me@acme.test" }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("from_addr_not_allowed");
    expect(sent).toHaveLength(0);
    void acme;
  });

  it("rejects more than 50 recipients", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const to = Array.from({ length: 51 }, (_, i) => `p${i}@example.test`);

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ to }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("rejects an empty recipient list and an invalid address", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");
    const headers = { authorization: `Bearer ${tenant.key}` };

    const empty = await app.inject({ method: "POST", url: "/v1/outbound", headers, payload: body({ to: [] }) });
    expect(empty.statusCode).toBe(400);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers,
      payload: body({ to: ["not-an-email"] }),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("rejects a message with neither html nor text", async () => {
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: { fromAddr: "me@acme.test", to: ["a@b.test"], subject: "s" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("returns 429 once the hourly limit is reached", async () => {
    app = makeApp(2);
    const tenant = createTenant("Acme", "acme.test");
    const headers = { authorization: `Bearer ${tenant.key}` };

    for (let i = 0; i < 2; i += 1) {
      const ok = await app.inject({ method: "POST", url: "/v1/outbound", headers, payload: body() });
      expect(ok.statusCode).toBe(202);
    }

    const limited = await app.inject({ method: "POST", url: "/v1/outbound", headers, payload: body() });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("outbound_rate_limited");
    expect(sent).toHaveLength(2);
  });

  it("returns 503 when no provider is configured", async () => {
    db = openDb(":memory:");
    migrate(db);
    const previous = provider;
    provider = undefined as unknown as MailProvider;
    const config = {
        ...loadConfig({
          INGEST_HMAC_SECRET: "a".repeat(32),
          ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
          SIGNED_URL_SECRET: "b".repeat(32),
          PUBLIC_BASE_URL: "https://mail.example.test",
        }),
        resendApiKey: undefined,
      };
    const adminAuthGuard = createAdminAuthGuard(db, config.adminBootstrapToken);
    app = buildApp({
      config,
      db,
      storage: {} as never,
      mailProvider: null,
      adminAuthGuard,
    });
    const tenant = createTenant("Acme", "acme.test");

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("mail_provider_not_configured");
    provider = previous;
  });

  it("records a terminal provider rejection as a failed message without retrying", async () => {
    provider = {
      send: async () => ({ accepted: false, error: "invalid_from: domain not verified", terminal: true }),
    };
    app = makeApp();
    const tenant = createTenant("Acme", "acme.test");

    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body(),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(false);
    expect(res.json().error).toMatch(/invalid_from/);

    const row = db.prepare("SELECT status, error FROM outbound_messages").get() as {
      status: string;
      error: string;
    };
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/invalid_from/);
    // The delivery should be marked dead (no retry)
    const delivery = db.prepare("SELECT status FROM outbound_deliveries").get() as { status: string };
    expect(delivery.status).toBe("dead");
  });
});