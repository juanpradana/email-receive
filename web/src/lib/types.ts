export interface MessageListItem {
  id: string;
  envelopeFrom: string;
  envelopeTo: string;
  subject: string | null;
  fromAddr: string | null;
  fromName: string | null;
  receivedAt: string;
  snippet: string | null;
  status: "pending" | "stored" | "failed";
}

export interface MessageDetail extends MessageListItem {
  messageIdHeader: string | null;
  bodyText: string | null;
  hasHtml: boolean;
  to: Array<{ address: string; name: string | null }>;
  cc: Array<{ address: string; name: string | null }>;
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    disposition: string | null;
  }>;
}

export interface OutboundListItem {
  id: string;
  fromAddr: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  status: "pending" | "sent" | "failed" | "bounced";
  error: string | null;
  messageId: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ComposeInput {
  fromAddr: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface ReplyInput {
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}
