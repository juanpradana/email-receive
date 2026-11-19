import type { Mailbox } from "./mailbox.js";
import type { ComposeInput, MessageDetail, MessageListItem, OutboundListItem, ReplyInput } from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

async function request(mailbox: Mailbox, method: "GET" | "POST", url: string, body?: unknown) {
  const res = await fetch(`${mailbox.baseUrl}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${mailbox.apiKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let code = "request_error";
    let message: string | undefined;
    try {
      const json = (await res.json()) as { error?: string; message?: string };
      if (json.error) code = json.error;
      message = json.message;
    } catch {
      // Non-JSON body — keep the HTTP status as the only signal.
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined;
  return res.json() as Promise<unknown>;
}

export async function listMessages(mailbox: Mailbox, limit = 50): Promise<MessageListItem[]> {
  const data = await request(mailbox, "GET", `/v1/messages?limit=${limit}`);
  return (data as { messages: MessageListItem[] }).messages;
}

export async function getMessage(mailbox: Mailbox, id: string): Promise<MessageDetail> {
  const data = await request(mailbox, "GET", `/v1/messages/${encodeURIComponent(id)}`);
  return (data as { message: MessageDetail }).message;
}

export async function listOutbound(mailbox: Mailbox, limit = 50): Promise<OutboundListItem[]> {
  const data = await request(mailbox, "GET", `/v1/outbound?limit=${limit}`);
  return (data as { messages: OutboundListItem[] }).messages;
}

export async function sendOutbound(mailbox: Mailbox, input: ComposeInput): Promise<{ accepted: boolean; error?: string }> {
  const data = await request(mailbox, "POST", "/v1/outbound", input);
  return data as { accepted: boolean; error?: string };
}

export async function replyTo(
  mailbox: Mailbox,
  messageId: string,
  input: ReplyInput,
): Promise<{ accepted: boolean; error?: string }> {
  const data = await request(mailbox, "POST", `/v1/messages/${encodeURIComponent(messageId)}/reply`, input);
  return data as { accepted: boolean; error?: string };
}
