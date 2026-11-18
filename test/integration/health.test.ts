import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const db = new Database(":memory:");
const storage = {
  putRaw: async () => "",
  putAttachment: async () => "",
  putHtml: async () => "",
  read: async () => Buffer.alloc(0),
  delete: async () => undefined,
  sweepTmp: async () => undefined,
};

const app = buildApp({
  config: loadConfig({
    INGEST_HMAC_SECRET: "a".repeat(32),
    ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
    SIGNED_URL_SECRET: "b".repeat(32),
    PUBLIC_BASE_URL: "https://mail.example.test",
  }),
  db,
  storage,
});

afterEach(async () => app.close());

describe("health endpoints", () => {
  it("returns ok from /healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});