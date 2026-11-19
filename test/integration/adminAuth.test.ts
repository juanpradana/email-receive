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
const adminEmail = "admin@example.test";
const adminPassword = "correct-horse-battery-staple";

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  const adminAuthGuard = createAdminAuthGuard(db, adminToken);
  adminAuthGuard.ensureBootstrapUser(adminEmail, adminPassword);
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

async function login(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/login",
    payload: { email, password },
  });
}

function withSession(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("admin user auth", () => {
  it("logs in with the seeded admin credentials and returns a session token", async () => {
    const res = await login(adminEmail, adminPassword);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.adminSessionToken).toMatch(/^at_/);
  });

  it("rejects a wrong password without leaking which field failed", async () => {
    const res = await login(adminEmail, "nope");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects an unknown admin email as the same 401", async () => {
    const res = await login("nobody@example.test", adminPassword);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("lets a valid session token call admin routes", async () => {
    const loginRes = await login(adminEmail, adminPassword);
    const token = loginRes.json().adminSessionToken as string;

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: withSession(token),
      payload: { name: "From Session" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tenant.name).toBe("From Session");
  });

  it("still accepts the legacy bootstrap token after sessions exist", async () => {
    const loginRes = await login(adminEmail, adminPassword);
    expect(loginRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("logs a session out so its token no longer authenticates", async () => {
    const loginRes = await login(adminEmail, adminPassword);
    const token = loginRes.json().adminSessionToken as string;

    const logout = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: withSession(token),
    });
    expect(logout.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/tenants",
      headers: withSession(token),
    });
    expect(res.statusCode).toBe(401);
  });
});
