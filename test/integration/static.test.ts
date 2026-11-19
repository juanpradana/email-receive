import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { openDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

let root: string;
let db: Database.Database;
let app: ReturnType<typeof buildApp> | undefined;

function makeApp(webDist?: string) {
  return buildApp({
    config: loadConfig({
      INGEST_HMAC_SECRET: "a".repeat(32),
      ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
      SIGNED_URL_SECRET: "b".repeat(32),
      PUBLIC_BASE_URL: "https://mail.example.test",
    }),
    db,
    storage: {} as never,
    mailProvider: null,
    webDist,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "email-receive-static-"));
  db = openDb(":memory:");
  migrate(db);
});
afterEach(async () => {
  await app?.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("webmail static serving", () => {
  it("serves index.html at the web root when web/dist exists", async () => {
    const dist = path.join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>webmail</title>");

    app = makeApp(dist);
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("webmail");
  });

  it("falls back to index.html for a client-side route", async () => {
    const dist = path.join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>webmail</title>");

    app = makeApp(dist);
    const res = await app.inject({ method: "GET", url: "/inbox" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("webmail");
  });

  it("keeps API routes ahead of the SPA fallback", async () => {
    const dist = path.join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>webmail</title>");

    app = makeApp(dist);
    const res = await app.inject({ method: "GET", url: "/v1/messages" });

    // Unauthenticated API call: the API answers, not the SPA.
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("webmail");
  });

  it("does not serve the SPA when web/dist is missing", async () => {
    app = makeApp(path.join(root, "does-not-exist"));
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(404);
  });
});