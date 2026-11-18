import type Database from "better-sqlite3";
import { newId } from "../db/client.js";
import type { MessageRow } from "../db/repo/messages.js";
import { createMessagesRepo } from "../db/repo/messages.js";
import { parseEmail, type ParsedEmail } from "./parse.js";
import type { Storage } from "./storage.js";

const SNIPPET_LENGTH = 200;

function snippet(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, SNIPPET_LENGTH) : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function persistParsed(
  db: Database.Database,
  storage: Storage,
  message: MessageRow,
  parsed: ParsedEmail,
): Promise<void> {
  const written: string[] = [];
  try {
    const htmlPath = parsed.html === null ? null : await storage.putHtml(message.id, parsed.html);
    if (htmlPath) written.push(htmlPath);

    const attachments: Array<{ id: string; partIndex: number; filename: string; contentType: string; disposition: string | null; contentId: string | null; isInline: boolean; sizeBytes: number; path: string }> = [];
    for (const attachment of parsed.attachments) {
      const attachmentPath = await storage.putAttachment(
        message.id,
        attachment.partIndex,
        attachment.filename,
        attachment.bytes,
      );
      written.push(attachmentPath);
      attachments.push({
        id: newId(),
        partIndex: attachment.partIndex,
        filename: attachment.filename,
        contentType: attachment.contentType,
        disposition: attachment.disposition,
        contentId: attachment.contentId,
        isInline: attachment.isInline,
        sizeBytes: attachment.bytes.length,
        path: attachmentPath,
      });
    }

    const messages = createMessagesRepo(db);
    const recipients = [
      ...parsed.to.map((address) => ({ kind: "to" as const, ...address })),
      ...parsed.cc.map((address) => ({ kind: "cc" as const, ...address })),
    ];

    db.transaction(() => {
      const insertRecipient = db.prepare(
        "INSERT OR IGNORE INTO message_recipients (message_id, kind, address, name) VALUES (?, ?, ?, ?)",
      );
      for (const recipient of recipients) {
        insertRecipient.run(message.id, recipient.kind, recipient.address, recipient.name);
      }

      const insertAttachment = db.prepare(
        `INSERT INTO attachments
           (id, message_id, part_index, filename, content_type, disposition, content_id, is_inline, size_bytes, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const attachment of attachments) {
        insertAttachment.run(
          attachment.id,
          message.id,
          attachment.partIndex,
          attachment.filename,
          attachment.contentType,
          attachment.disposition,
          attachment.contentId,
          attachment.isInline ? 1 : 0,
          attachment.sizeBytes,
          attachment.path,
        );
      }

      messages.markStored(message.tenant_id, message.id, {
        subject: parsed.subject,
        fromAddr: parsed.fromAddr,
        fromName: parsed.fromName,
        bodyText: parsed.text,
        snippet: snippet(parsed.text),
        htmlPath,
        messageIdHeader: parsed.messageId,
      });
    })();
  } catch (error) {
    for (const path of written) {
      await storage.delete(path).catch(() => undefined);
    }
    throw error;
  }
}

export async function processPending(db: Database.Database, storage: Storage, limit: number): Promise<number> {
  const messages = createMessagesRepo(db);
  const pending = messages.listPending(limit);
  let stored = 0;

  for (const message of pending) {
    try {
      const raw = await storage.read(message.raw_path);
      const parsed = await parseEmail(raw);
      await persistParsed(db, storage, message, parsed);
      stored += 1;
    } catch (error) {
      messages.markFailed(message.tenant_id, message.id, errorMessage(error));
    }
  }

  return stored;
}