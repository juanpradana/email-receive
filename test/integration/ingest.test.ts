import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { buildIngestHeader } from "../../src/auth/ingestAuth.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { createLocalStorage } from "../../src/services/storage.js";

const secret = "s".repeat(32);
let root: string;
let db: Database.Database;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "email-receive-ingest-"));
  db = openDb(path.join(root, "test.db"));
  migrate(db);
  app = buildApp({
    config: loadConfig({
      INGEST_HMAC_SECRET: secret,
      ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
      DATA_DIR: root,
      MAX_MESSAGE_BYTES: "2048",
    }),
    db,
    storage: createLocalStorage(root),
  });

  const tenant = await app.inject({
    method: "POST",
    url: "/v1/admin/tenants",
    headers: { authorization: "Bearer admin-bootstrap-token" },
    payload: { name: "Acme" },
  });
  const tenantId = tenant.json().tenant.id as string;
  await app.inject({
    method: "POST",
    url: `/v1/admin/tenants/${tenantId}/domains`,
    headers: { authorization: "Bearer admin-bootstrap-token" },
    payload: { domain: "mail.acme.test" },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function ingestRequest(body: string, overrides: { to?: string; contentType?: string; signedBody?: string; tenantSecret?: string } = {}) {
  const bytes = Buffer.from(body);
  const now = Math.floor(Date.now() / 1000);
  return app.inject({
    method: "POST",
    url: "/v1/ingest",
    headers: {
      "content-type": overrides.contentType ?? "message/rfc822",
      "x-envelope-from": "sender@example.test",
      "x-envelope-to": overrides.to ?? "inbox@mail.acme.test",
      "x-ingest-signature": buildIngestHeader(
        overrides.tenantSecret ?? secret,
        now,
        Buffer.from(overrides.signedBody ?? body),
      ),
    },
    payload: bytes,
  });
}

describe("POST /v1/ingest", () => {
  it("stores a message and returns 202", async () => {
    const res = await ingestRequest("Subject: Hello\r\n\r\nWorld");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: expect.any(String), status: "pending", duplicate: false });

    const rows = db.prepare("SELECT * FROM messages").all() as Array<{ status: string; raw_path: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(readFileSync(rows[0]!.raw_path, "utf8")).toContain("Subject: Hello");
  });

  it("returns the same id for a duplicate hash inside the window", async () => {
    const first = await ingestRequest("Subject: Once\r\n\r\nBody");
    const second = await ingestRequest("Subject: Once\r\n\r\nBody");
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ id: first.json().id, status: "pending", duplicate: true });
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
    expect(readdirSync(path.join(root, "raw"), { recursive: true }).filter((e) => String(e).endsWith(".eml"))).toHaveLength(1);
  });

  it("rejects an unregistered recipient domain with 404", async () => {
    const res = await ingestRequest("Subject: Hi\r\n\r\nBody", { to: "x@unknown.test" });
    expect(res.statusCode).toBe(404);
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  it("rejects body larger than MAX_MESSAGE_BYTES with 413", async () => {
    const res = await ingestRequest(`Subject: Big\r\n\r\n${"x".repeat(4096)}`);
    expect(res.statusCode).toBe(413);
  });

  it("rejects wrong content type with 415", async () => {
    const res = await ingestRequest("Subject: Hi\r\n\r\nBody", { contentType: "application/json" });
    expect(res.statusCode).toBe(415);
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    const body = "Subject: Hi\r\n\r\nBody";
    const res = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "message/rfc822",
        "x-envelope-from": "sender@example.test",
        "x-envelope-to": "inbox@mail.acme.test",
        "x-ingest-signature": buildIngestHeader(secret, Math.floor(Date.now() / 1000), Buffer.from(body)),
      },
      payload: Buffer.from("Subject: Tampered\r\n\r\nBody"),
    });
    expect(res.statusCode).toBe(401);
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  it("body limit does not close the connection without a JSON error", async () => {
    const res = await ingestRequest(`Subject: Big\r\n\r\n${"x".repeat(100_000)}`);
    expect([413, 400]).toContain(res.statusCode);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});