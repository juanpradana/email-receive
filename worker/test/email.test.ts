import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { forwardEmail, type Env, type ForwardableEmailMessage } from "../src/index.js";

const SECRET = "worker-hmac-secret-0123456789abcdef";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const env: Env = {
  INGEST_URL: "https://api.example.test/v1/ingest",
  INGEST_HMAC_SECRET: SECRET,
};

function makeMessage(raw: Buffer, from = "sender@example.test", to = "inbox@acme.test") {
  const reject = vi.fn<(reason: string) => void>();
  const message: ForwardableEmailMessage = {
    from,
    to,
    rawSize: raw.length,
    raw: new Response(new Uint8Array(raw)).body as ReadableStream,
    setReject: reject,
  };
  return { message, reject };
}

function expectedSignature(body: Buffer, timestamp: number): string {
  const digest = createHash("sha256").update(body).digest("hex");
  const v1 = createHmac("sha256", SECRET).update(`${timestamp}.${digest}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const ctx = { waitUntil: () => undefined };
const clock = () => NOW;
const noSleep = () => Promise.resolve();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloudflare email worker", () => {
  it("posts raw bytes with signed envelope headers", async () => {
    const raw = Buffer.from("Subject: Hi\r\n\r\nHello\r\n");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "m1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const { message, reject } = makeMessage(raw);
    await worker.email(message, env, ctx);

    expect(reject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(env.INGEST_URL);
    expect(init.method).toBe("POST");
    expect(headers["content-type"]).toBe("message/rfc822");
    expect(headers["x-envelope-from"]).toBe("sender@example.test");
    expect(headers["x-envelope-to"]).toBe("inbox@acme.test");
    expect(Buffer.from(init.body as Uint8Array).equals(raw)).toBe(true);

    const signatureHeader = headers["x-ingest-signature"]!;
    expect(signatureHeader).toBe(expectedSignature(raw, Math.floor(Date.now() / 1000)));
  });

  it("does not call fetch and rejects mail above MAX_BYTES", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { message, reject } = makeMessage(Buffer.alloc(64));

    await worker.email(message, { ...env, MAX_BYTES: "16" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]).toMatch(/maximum allowed size/i);
  });

  it("throws when the API responds 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(noSleep);

    const { message } = makeMessage(Buffer.from("Subject: Hi\r\n\r\nHello\r\n"));

    await expect(forwardEmail(message, env, { sleep, now: clock })).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[250], [1000], [2500]]);
  });

  it("retries transient failures up to 3 times", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(noSleep);

    const { message } = makeMessage(Buffer.from("Subject: Hi\r\n\r\nHello\r\n"));

    await expect(forwardEmail(message, env, { sleep, now: clock })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[250], [1000], [2500]]);
  });

  it("gives every ingest attempt a timeout signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const { message } = makeMessage(Buffer.from("Subject: Hi\r\n\r\nHello\r\n"));
    await forwardEmail(message, env, { sleep: noSleep, now: clock });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it("does not retry a permanent 404 and throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(noSleep);

    const { message } = makeMessage(Buffer.from("Subject: Hi\r\n\r\nHello\r\n"));

    await expect(forwardEmail(message, env, { sleep, now: clock })).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});