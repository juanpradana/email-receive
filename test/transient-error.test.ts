import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { generateApiKey } from "../src/auth/apiKey.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createApiKeysRepo } from "../src/db/repo/apiKeys.js";
import { createTenantsRepo } from "../src/db/repo/tenants.js";
import type { MailProvider } from "../src/services/mail/provider.js";

let db: Database.Database;
let app: ReturnType<typeof buildApp>;

function makeApp() {
  return buildApp({
    config: {
      ...loadConfig({
        INGEST_HMAC_SECRET: "a".repeat(32),
        ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
        SIGNED_URL_SECRET: "b".repeat(32),
        PUBLIC_BASE_URL: "https://mail.example.test",
      }),
      resendApiKey: "test-key",
      outboundRateLimitPerHour: 10,
      outboundRateLimitPerDay: 100,
    },
    db,
    storage: {} as never,
    mailProvider: provider,
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

const body = (overrides: Record<string, unknown> = {}) => ({
  fromAddr: "me@acme.test",
  to: ["friend@example.test"],
  subject: "Hello",
  text: "Hi there",
  ...overrides,
});

let provider: MailProvider;
let lastSend: { status: number; isTransient: boolean } | null = null;

describe("transient vs terminal provider errors", () => {
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db);
    lastSend = null;
    provider = {
      async send(input) {
        // Resend 503 = transient, 401 = terminal
        const status: 401 | 503 = input.subject === "transient" ? 503 : 401;
        lastSend = { status, isTransient: status >= 500 };
        return {
          accepted: false,
          error: `HTTP ${status}: test`,
          // Terminal for 4xx, transient for 5xx
          terminal: status < 500,
        };
      },
    };
    app = makeApp();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("leaves delivery pending for transient 5xx so dispatcher can retry", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ subject: "transient" }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(false);
    expect(res.json().error).toMatch(/503/);

    // The delivery row should NOT be 'dead' - it should stay 'pending' for dispatcher retry
    const delivery = db.prepare("SELECT status, attempts FROM outbound_deliveries").get() as {
      status: string;
      attempts: number;
    };
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(1); // first attempt recorded
  });

  it("marks delivery dead for terminal 4xx (invalid domain)", async () => {
    const tenant = createTenant("Acme", "acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/outbound",
      headers: { authorization: `Bearer ${tenant.key}` },
      payload: body({ subject: "terminal" }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(false);
    expect(res.json().error).toMatch(/401/);

    // The delivery row should be 'dead' - no retry
    const delivery = db.prepare("SELECT status, attempts FROM outbound_deliveries").get() as {
      status: string;
      attempts: number;
    };
    expect(delivery.status).toBe("dead");
    expect(delivery.attempts).toBe(1);
  });
});