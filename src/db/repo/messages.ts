import type Database from "better-sqlite3";

export type MessageStatus = "pending" | "stored" | "failed";

export interface MessageRow {
  id: string;
  tenant_id: string;
  envelope_from: string;
  envelope_to: string;
  recipient_domain: string;
  message_id_header: string | null;
  sha256: string;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  received_at: string;
  size_bytes: number;
  raw_path: string;
  body_text: string | null;
  html_path: string | null;
  snippet: string | null;
  status: MessageStatus;
  error: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface NewMessage {
  id: string;
  tenantId: string;
  envelopeFrom: string;
  envelopeTo: string;
  recipientDomain: string;
  sha256: string;
  receivedAt: string;
  sizeBytes: number;
  rawPath: string;
  status?: MessageStatus;
  createdAt?: string;
}

export interface MessageFilter {
  limit?: number;
  cursor?: { receivedAt: string; id: string };
  from?: string;
  to?: string;
  subject?: string;
}

export interface MessagesRepo {
  insert(row: NewMessage): MessageRow;
  findById(tenantId: string, id: string): MessageRow | undefined;
  findDuplicate(tenantId: string, sha256: string, sinceIso: string): MessageRow | undefined;
  list(tenantId: string, filter: MessageFilter): MessageRow[];
  markStored(
    tenantId: string,
    id: string,
    data: { subject: string | null; fromAddr: string | null; fromName: string | null; bodyText: string | null; snippet: string | null; htmlPath: string | null; messageIdHeader: string | null },
  ): void;
  markFailed(tenantId: string, id: string, error: string): void;
  softDelete(tenantId: string, id: string): boolean;
  deleteHard(id: string): void;
  listPending(limit: number): MessageRow[];
  listOlderThan(cutoffIso: string, limit: number): MessageRow[];
}

export function createMessagesRepo(db: Database.Database): MessagesRepo {
  return {
    insert(row) {
      const createdAt = row.createdAt ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO messages
           (id, tenant_id, envelope_from, envelope_to, recipient_domain, sha256, received_at, size_bytes, raw_path, status, created_at)
         VALUES (@id, @tenantId, @envelopeFrom, @envelopeTo, @recipientDomain, @sha256, @receivedAt, @sizeBytes, @rawPath, @status, @createdAt)`,
      ).run({ ...row, status: row.status ?? "pending", createdAt });
      return this.findById(row.tenantId, row.id)!;
    },

    findById(tenantId, id) {
      return db.prepare("SELECT * FROM messages WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL").get(
        tenantId,
        id,
      ) as MessageRow | undefined;
    },

    findDuplicate(tenantId, sha256, sinceIso) {
      return db
        .prepare(
          "SELECT * FROM messages WHERE tenant_id = ? AND sha256 = ? AND received_at >= ? AND deleted_at IS NULL ORDER BY received_at DESC LIMIT 1",
        )
        .get(tenantId, sha256, sinceIso) as MessageRow | undefined;
    },

    list(tenantId, filter) {
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
      const clauses = ["tenant_id = ?", "deleted_at IS NULL"];
      const params: unknown[] = [tenantId];
      if (filter.from) {
        clauses.push("instr(lower(coalesce(from_addr, '')), lower(?)) > 0");
        params.push(filter.from);
      }
      if (filter.to) {
        clauses.push("instr(lower(envelope_to), lower(?)) > 0");
        params.push(filter.to);
      }
      if (filter.subject) {
        clauses.push("instr(lower(coalesce(subject, '')), lower(?)) > 0");
        params.push(filter.subject);
      }
      if (filter.cursor) {
        clauses.push("(received_at < ? OR (received_at = ? AND id < ?))");
        params.push(filter.cursor.receivedAt, filter.cursor.receivedAt, filter.cursor.id);
      }
      params.push(limit);
      return db
        .prepare(
          `SELECT * FROM messages WHERE ${clauses.join(" AND ")}
           ORDER BY received_at DESC, id DESC LIMIT ?`,
        )
        .all(...params) as MessageRow[];
    },

    markStored(tenantId, id, data) {
      db.prepare(
        `UPDATE messages SET status = 'stored', subject = ?, from_addr = ?, from_name = ?, body_text = ?,
           snippet = ?, html_path = ?, message_id_header = ?, error = NULL
         WHERE tenant_id = ? AND id = ?`,
      ).run(data.subject, data.fromAddr, data.fromName, data.bodyText, data.snippet, data.htmlPath, data.messageIdHeader, tenantId, id);
    },

    markFailed(tenantId, id, error) {
      db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE tenant_id = ? AND id = ?").run(
        error.slice(0, 2000),
        tenantId,
        id,
      );
    },

    softDelete(tenantId, id) {
      const result = db
        .prepare("UPDATE messages SET deleted_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL")
        .run(new Date().toISOString(), tenantId, id);
      return result.changes > 0;
    },

    deleteHard(id) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    },

    listPending(limit) {
      return db
        .prepare("SELECT * FROM messages WHERE status = 'pending' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT ?")
        .all(limit) as MessageRow[];
    },

    listOlderThan(cutoffIso, limit) {
      return db
        .prepare("SELECT * FROM messages WHERE received_at < ? ORDER BY received_at ASC LIMIT ?")
        .all(cutoffIso, limit) as MessageRow[];
    },
  };
}