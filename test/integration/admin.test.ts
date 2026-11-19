import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/client.js";
import { createAdminAuthGuard } from "../../src/auth/apiKey.js";

let db: Database.Database;
let app: ReturnType<typeof buildApp>;
const adminToken = "admin-bootstrap-token";

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  const adminAuthGuard = createAdminAuthGuard(db, adminToken);
  app = buildApp({
    config: loadConfig({
      INGEST_HMAC_SECRET: "a".repeat(32),
      ADMIN_BOOTSTRAP_TOKEN: adminToken,
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
    }),
    db,
    storage: {} as never,
    adminAuthGuard,
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const admin = { authorization: `Bearer ${adminToken}` };

async function createTenant(name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/tenants",
    headers: admin,
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().tenant as { id: string; name: string };
}

describe("admin provisioning", () => {
  it("rejects a non-admin token for provisioning", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { authorization: "Bearer wrong" },
      payload: { name: "Acme" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a tenant and returns a plaintext key only once", async () => {
    const tenant = await createTenant("Acme");
    const keyRes = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${tenant.id}/keys`,
      headers: admin,
      payload: { name: "automation", scopes: ["read"] },
    });
    expect(keyRes.statusCode).toBe(201);
    const body = keyRes.json();
    expect(body.apiKey.plaintext).toMatch(/^ek_/);
    expect(body.apiKey.prefix).toHaveLength(8);

    const listed = await app.inject({ method: "GET", url: `/v1/admin/tenants/${tenant.id}/keys`, headers: admin });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(body.apiKey.plaintext);
  });

  it("registers a domain and rejects duplicates", async () => {
    const tenant = await createTenant("Acme");
    const other = await createTenant("Other");
    const first = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${tenant.id}/domains`,
      headers: admin,
      payload: { domain: "Mail.Acme.Test" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${other.id}/domains`,
      headers: admin,
      payload: { domain: "mail.acme.test" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("returns 400 with details for an invalid body instead of 500", async () => {
    const tenant = await createTenant("Acme");
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/tenants/${tenant.id}/domains`,
      headers: admin,
      payload: { domain: "not a domain" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("validation_error");
    expect(body.details.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT count(*) AS n FROM tenant_domains").get()).toEqual({ n: 0 });
  });

  it("returns 404 for an unknown tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants/missing/keys",
      headers: admin,
      payload: { name: "automation", scopes: ["read"] },
    });
    expect(res.statusCode).toBe(404);
  });
});