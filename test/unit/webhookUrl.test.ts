import { describe, expect, it } from "vitest";
import { assertSafeWebhookUrl } from "../../src/lib/webhookUrl.js";
import { signWebhook } from "../../src/services/webhooks.js";

describe("webhook URL safety", () => {
  it.each([
    "http://example.com/hook",
    "http://localhost/hook",
    "https://127.0.0.1/h",
    "https://169.254.169.254/h",
    "https://10.0.0.2/h",
    "https://192.168.1.1/h",
    "https://[::1]/h",
    "https://0.0.0.0/h",
  ])("rejects %s", async (url) => {
    await expect(assertSafeWebhookUrl(url, false)).rejects.toThrow();
  });

  it("accepts a public https URL and rejects credentials in the URL", async () => {
    await expect(
      assertSafeWebhookUrl("https://hooks.example.com/inbound", false, async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeWebhookUrl("https://user:pass@hooks.example.com/inbound", false, async () => ["93.184.216.34"]),
    ).rejects.toThrow(/credentials/i);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(
      assertSafeWebhookUrl("https://rebind.example.com/hook", false, async () => ["10.1.2.3"]),
    ).rejects.toThrow(/private/i);
  });

  it("allows private targets only when explicitly enabled", async () => {
    await expect(
      assertSafeWebhookUrl("http://127.0.0.1:8080/hook", true, async () => ["127.0.0.1"]),
    ).resolves.toBeUndefined();
  });
});

describe("webhook signature", () => {
  it("produces a verifiable signature over timestamp and body", () => {
    const rawBody = JSON.stringify({ event: "message.received" });
    const secret = "w".repeat(32);
    const signature = signWebhook(secret, 1_700_000_000, rawBody);
    expect(signature).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(signWebhook(secret, 1_700_000_000, rawBody)).toBe(signature);
    expect(signWebhook(secret, 1_700_000_000, `${rawBody} `)).not.toBe(signature);
  });
});