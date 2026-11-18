import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const minimalEnv = () => ({
  INGEST_HMAC_SECRET: "a".repeat(32),
  ADMIN_BOOTSTRAP_TOKEN: "admin-bootstrap-token",
  SIGNED_URL_SECRET: "b".repeat(32),
  PUBLIC_BASE_URL: "https://mail.example.test",
});

describe("loadConfig", () => {
  it("rejects a missing INGEST_HMAC_SECRET", () => {
    expect(() => loadConfig({})).toThrow(/INGEST_HMAC_SECRET/);
  });

  it("defaults maxMessageBytes to 26214400", () => {
    expect(loadConfig(minimalEnv()).maxMessageBytes).toBe(26214400);
  });
});