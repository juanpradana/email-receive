export interface Env {
  INGEST_URL: string;
  INGEST_HMAC_SECRET: string;
  MAX_BYTES?: string;
}

export interface ForwardableEmailMessage {
  from: string;
  to: string;
  rawSize: number;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ForwardOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_MAX_BYTES = 26_214_400;
const RETRY_DELAYS_MS = [250, 1000, 2500] as const;
const REQUEST_TIMEOUT_MS = 15_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function maxBytes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("MAX_BYTES must be a positive safe integer");
  }
  return parsed;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signBody(secret: string, timestamp: number, body: Uint8Array): Promise<string> {
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  const bodyHash = await crypto.subtle.digest("SHA-256", bodyBuffer);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${toHex(bodyHash)}`),
  );
  return `t=${timestamp},v1=${toHex(signature)}`;
}

async function sendWithRetry(
  message: ForwardableEmailMessage,
  env: Env,
  body: Uint8Array,
  timestamp: number,
  receivedAt: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const signature = await signBody(env.INGEST_HMAC_SECRET, timestamp, body);
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetch(env.INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-envelope-from": message.from,
          "x-envelope-to": message.to,
          "x-received-at": receivedAt,
          "x-ingest-signature": signature,
        },
        body: new Uint8Array(body),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) return;
      retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      lastError = new Error(`Ingest API returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (!retryable) throw lastError;
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }

  throw lastError;
}

export async function forwardEmail(
  message: ForwardableEmailMessage,
  env: Env,
  options: ForwardOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());

  const limit = maxBytes(env.MAX_BYTES);
  if (message.rawSize > limit) {
    message.setReject(`Email exceeds the maximum allowed size of ${limit} bytes`);
    return;
  }

  if (!env.INGEST_URL || !env.INGEST_HMAC_SECRET) {
    throw new Error("INGEST_URL and INGEST_HMAC_SECRET must be configured");
  }

  const body = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (body.byteLength > limit) {
    message.setReject(`Email exceeds the maximum allowed size of ${limit} bytes`);
    return;
  }

  const receivedAt = now();
  await sendWithRetry(message, env, body, Math.floor(receivedAt.getTime() / 1000), receivedAt.toISOString(), sleep);
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env, _ctx?: ExecutionContext): Promise<void> {
    await forwardEmail(message, env);
  },
};

export default worker;