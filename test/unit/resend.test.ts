import { afterEach, describe, expect, it, vi } from "vitest";
import { createResendProvider } from "../../src/services/mail/resend.js";

afterEach(() => vi.unstubAllGlobals());

describe("resend provider", () => {
  it("posts the message and returns the provider id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "r1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createResendProvider("secret-key").send({
      fromAddr: "me@acme.test",
      to: ["friend@example.test"],
      subject: "hi",
      text: "hello",
    });

    expect(result).toEqual({ resendMessageId: "r1", accepted: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "me@acme.test",
      to: ["friend@example.test"],
      subject: "hi",
      text: "hello",
    });
  });

  it("never puts the api key in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "r1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createResendProvider("super-secret").send({ fromAddr: "a@b.test", to: ["c@d.test"], subject: "s" });

    expect(fetchMock.mock.calls[0]![1].body as string).not.toContain("super-secret");
  });

  it("surfaces the provider error on 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 403, name: "validation_error", message: "invalid_from: not allowed" }), {
        status: 403,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createResendProvider("k").send({ fromAddr: "a@b.test", to: ["c@d.test"], subject: "s" });

    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/invalid_from/);
  });

  it("reports a timeout instead of throwing when the request aborts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createResendProvider("k").send({ fromAddr: "a@b.test", to: ["c@d.test"], subject: "s" });

    expect(result).toEqual({ accepted: false, error: "timeout" });
  });

  it("reports a network error as a failed send", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createResendProvider("k").send({ fromAddr: "a@b.test", to: ["c@d.test"], subject: "s" });

    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/network down/);
  });

  it("attaches extra headers and a body timeout signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "r1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createResendProvider("k").send({
      fromAddr: "a@b.test",
      to: ["c@d.test"],
      subject: "s",
      headers: { "In-Reply-To": "<x@y.test>" },
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string).headers).toEqual({ "In-Reply-To": "<x@y.test>" });
  });
});