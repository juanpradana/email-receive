import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/lib/cursor.js";

describe("message cursors", () => {
  it("round-trips received timestamp and id", () => {
    const cursor = { receivedAt: "2026-11-18T12:00:00.000Z", id: "message-123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("not-base64-json")).toThrow();
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ receivedAt: "no-date", id: "" })).toString("base64url"))).toThrow();
  });
});
