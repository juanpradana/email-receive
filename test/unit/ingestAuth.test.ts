import { describe, expect, it } from "vitest";
import { buildIngestHeader, createIngestVerifier, signIngest } from "../../src/auth/ingestAuth.js";

const secret = "s".repeat(32);
const body = Buffer.from("Subject: Hi\r\n\r\nbody");

describe("ingest HMAC", () => {
  it("accepts a correctly signed request", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const t = Math.floor(now.getTime() / 1000);
    const verifier = createIngestVerifier(secret);
    expect(verifier.verify(buildIngestHeader(secret, t, body), body, now).ok).toBe(true);
  });

  it("rejects a stale timestamp", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const t = Math.floor(now.getTime() / 1000) - 3600;
    const verifier = createIngestVerifier(secret);
    expect(verifier.verify(buildIngestHeader(secret, t, body), body, now)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("treats an identical resend as a duplicate, not a signature failure", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const t = Math.floor(now.getTime() / 1000);
    const verifier = createIngestVerifier(secret);
    const header = buildIngestHeader(secret, t, body);
    expect(verifier.verify(header, body, now).ok).toBe(true);
    expect(verifier.verify(header, body, now).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const t = Math.floor(now.getTime() / 1000);
    const verifier = createIngestVerifier(secret);
    const header = buildIngestHeader(secret, t, body);
    expect(verifier.verify(header, Buffer.from("tampered"), now).ok).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    const t = Math.floor(now.getTime() / 1000);
    const verifier = createIngestVerifier(secret);
    expect(verifier.verify(buildIngestHeader("x".repeat(32), t, body), body, now).ok).toBe(false);
    expect(signIngest(secret, t, body)).toHaveLength(64);
  });
});