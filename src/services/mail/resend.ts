import type { MailProvider, MailProviderInput, MailProviderResult } from "./provider.js";

const RESEND_API = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export function createResendProvider(apiKey: string): MailProvider {
  return {
    async send(input: MailProviderInput): Promise<MailProviderResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const body: Record<string, unknown> = {
          from: input.fromAddr,
          to: input.to,
          subject: input.subject,
        };
        if (input.cc?.length) body.cc = input.cc;
        if (input.bcc?.length) body.bcc = input.bcc;
        if (input.html) body.html = input.html;
        if (input.text) body.text = input.text;
        if (input.headers) body.headers = input.headers;

        const response = await fetch(RESEND_API, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "user-agent": "email-receive/1 mail-provider",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          const data = (await response.json()) as { id: string };
          return { resendMessageId: data.id, accepted: true };
        }

        const errorBody = (await response.json().catch(() => ({}))) as { message?: string; name?: string };
        const statusText = `HTTP ${response.status}`;
        const errorMessage = errorBody.message ?? errorBody.name ?? statusText;
        // 4xx (except 429) and 4xx-like terminal errors are not retryable.
        // 5xx, 429, and timeouts are transient.
        const isTransient = response.status === 429 || response.status >= 500;
        return {
          accepted: false,
          error: `${statusText}: ${errorMessage}`,
          terminal: !isTransient,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { accepted: false, error: "timeout", terminal: false };
        }
        // Network errors and timeouts are transient
        return { accepted: false, error: error instanceof Error ? error.message : String(error), terminal: false };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}