import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const storage = {
  putRaw: async () => "",
  putAttachment: async () => "",
  putHtml: async () => "",
  read: async () => Buffer.alloc(0),
  delete: async () => undefined,
  sweepTmp: async () => undefined,
};

function makeApp(overrides: { dataDir?: string } = {}) {
  const db = new Database(":memory:");
  const config = loadConfig({
    INGEST_HMAC_SECRET: "a".repeat(32),
    ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
    SIGNED_URL_SECRET: "b".repeat(32),
    PUBLIC_BASE_URL: "https://mail.example.test",
  });
  if (overrides.dataDir) config.dataDir = overrides.dataDir;
  const app = buildApp({ config, db, storage });
  return { app, db };
}

const opened: Array<{ app: ReturnType<typeof buildApp>; db: Database.Database }> = [];

function track(overrides: { dataDir?: string } = {}) {
  const created = makeApp(overrides);
  opened.push(created);
  return created.app;
}

afterEach(async () => {
  for (const { app, db } of opened.splice(0)) {
    await app.close();
    db.close();
  }
});

describe("health endpoints", () => {
  it("returns ok from /healthz", async () => {
    const app = track();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns ready when the database and data dir are writable", async () => {
    const app = track();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("returns not-ready when DATA_DIR cannot be created as a directory", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "email-receive-health-"));
    const filePath = path.join(root, "not-a-directory");
    writeFileSync(filePath, "file");
    const app = track({ dataDir: filePath });

    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "not-ready" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});