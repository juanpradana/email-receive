import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface VerifyResult {
  ok: boolean;
  reason?: "malformed" | "stale" | "miss";
}

export interface IngestVerifier {
  verify(header: string | undefined, body: Buffer, now?: Date): VerifyResult;
}

export function signIngest(secret: string, timestamp: number, body: Buffer): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${timestamp}.${digest}`).digest("hex");
}

export function buildIngestHeader(secret: string, timestamp: number, body: Buffer): string {
  return `t=${timestamp},v1=${signIngest(secret, timestamp, body)}`;
}

function parseHeader(header: string): { timestamp: number; signature: string } | undefined {
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return index === -1 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  ) as Record<string, string>;
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1 || !/^[0-9a-f]{64}$/i.test(parts.v1)) return undefined;
  return { timestamp, signature: parts.v1.toLowerCase() };
}

export function createIngestVerifier(secret: string): IngestVerifier {
  return {
    verify(header, body, now = new Date()) {
      if (!header) return { ok: false, reason: "malformed" };
      const parsed = parseHeader(header);
      if (!parsed) return { ok: false, reason: "malformed" };

      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (Math.abs(nowSeconds - parsed.timestamp) > MAX_CLOCK_SKEW_SECONDS) {
        return { ok: false, reason: "stale" };
      }

      const expected = Buffer.from(signIngest(secret, parsed.timestamp, body), "hex");
      const provided = Buffer.from(parsed.signature, "hex");
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        return { ok: false, reason: "miss" };
      }

      return { ok: true };
    },
  };
}