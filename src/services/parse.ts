import PostalMime from "postal-mime";
import type { Address, Attachment as PostalAttachment, Email } from "postal-mime";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;

export interface ParsedAddress {
  address: string;
  name: string;
}

export interface ParsedAttachment {
  partIndex: number;
  filename: string;
  contentType: string;
  disposition: string | null;
  contentId: string | null;
  isInline: boolean;
  bytes: Buffer;
}

export interface ParsedEmail {
  subject: string | null;
  fromAddr: string | null;
  fromName: string | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  messageId: string | null;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}

export interface ParseEmailOptions {
  maxAttachmentBytes?: number;
  maxAttachments?: number;
}

function addresses(items: Address[] | undefined): ParsedAddress[] {
  const result: ParsedAddress[] = [];
  const append = (item: Address): void => {
    if ("group" in item && Array.isArray(item.group)) {
      for (const member of item.group) append(member);
    } else if (item.address) {
      result.push({ address: item.address, name: item.name });
    }
  };
  for (const item of items ?? []) append(item);
  return result;
}

function primaryAddress(address: Address | undefined): ParsedAddress | null {
  if (!address) return null;
  const flattened = addresses([address]);
  return flattened[0] ?? null;
}

function attachmentBytes(attachment: PostalAttachment): Buffer {
  const content = attachment.content;
  if (typeof content === "string") {
    return attachment.encoding === "base64"
      ? Buffer.from(content, "base64")
      : Buffer.from(content, "utf8");
  }
  return content instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(content))
    : Buffer.from(content);
}

export async function parseEmail(bytes: Buffer, options: ParseEmailOptions = {}): Promise<ParsedEmail> {
  const maxAttachmentBytes = options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  const maxAttachments = options.maxAttachments ?? MAX_ATTACHMENTS;
  const email: Email = await PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });
  const from = primaryAddress(email.from);

  if (email.attachments.length > maxAttachments) {
    throw new Error(`Email exceeds the maximum of ${maxAttachments} attachments`);
  }

  let totalAttachmentBytes = 0;
  const attachments = email.attachments.map((attachment, partIndex) => {
    const content = attachmentBytes(attachment);
    totalAttachmentBytes += content.length;
    if (totalAttachmentBytes > maxAttachmentBytes) {
      throw new Error(`Email attachments exceed the ${maxAttachmentBytes}-byte limit`);
    }
    return {
      partIndex,
      filename: attachment.filename || "attachment",
      contentType: attachment.mimeType,
      disposition: attachment.disposition,
      contentId: attachment.contentId ?? null,
      isInline: attachment.disposition === "inline" || attachment.related === true,
      bytes: content,
    };
  });

  return {
    subject: email.subject ?? null,
    fromAddr: from?.address ?? null,
    fromName: from?.name || null,
    to: addresses(email.to),
    cc: addresses(email.cc),
    messageId: email.messageId ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    attachments,
  };
}
