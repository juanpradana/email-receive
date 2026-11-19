import type Database from "better-sqlite3";
import { newId } from "../client.js";

export type OutboundStatus = "pending" | "sent" | "failed" | "bounced";
export type OutboundDeliveryStatus = "pending" | "in_flight" | "delivered" | "bounced" | "dead";

export interface OutboundRow {
  id: string;
  tenant_id: string;
  from_addr: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  html: string | null;
  text: string | null;
  message_id: string | null;
  status: OutboundStatus;
  error: string | null;
  delivered_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface NewOutbound {
  tenantId: string;
  fromAddr: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  createdAt?: string;
}

export interface OutboundFilter {
  limit?: number;
  status?: OutboundStatus;
}

export interface OutboundDeliveriesRepo {
  create(input: {
    messageId: string;
    nextAttemptAt?: string;
    status?: "pending" | "bounced";
  }): { id: string };
  /** Atomically claims a delivery so concurrent callers cannot double-send. */
  claimForAttempt(id: string, nowIso?: string): boolean;
  findDue(nowIso: string, limit: number): Array<
    {
      id: string;
      message_id: string;
      resend_message_id: string | null;
      attempts: number;
      next_attempt_at: string;
      status: OutboundDeliveryStatus;
    } & Record<string, unknown>
  >;
  findByMessage(messageId: string):
    | {
        id: string;
        message_id: string;
        resend_message_id: string | null;
        attempts: number;
        next_attempt_at: string;
        status: OutboundDeliveryStatus;
        last_error: string | null;
      }
    | undefined;
  markDelivered(id: string, resendMessageId: string, nowIso?: string): void;
  markBounced(id: string, error: string, nowIso?: string): void;
  markAttempt(id: string, attempts: number, error: string, nextAttemptAtIso: string, nowIso?: string): void;
  markDead(id: string, attempts: number, error: string, nowIso?: string): void;
}

export function createOutboundRepo(db: Database.Database) {
  const list = (tenantId: string, filter: OutboundFilter = {}) => {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
    const clauses = ["tenant_id = ?", "deleted_at IS NULL"];
    const params: unknown[] = [tenantId];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    params.push(limit);
    return db
      .prepare(
        `SELECT * FROM outbound_messages WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as OutboundRow[];
  };

  return {
    insert(input: NewOutbound): OutboundRow {
      const id = newId();
      const createdAt = input.createdAt ?? new Date().toISOString();
      db.prepare(
        `INSERT INTO outbound_messages
           (id, tenant_id, from_addr, to_json, cc_json, bcc_json, subject, html, text, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        id,
        input.tenantId,
        input.fromAddr,
        JSON.stringify(input.to),
        JSON.stringify(input.cc ?? []),
        JSON.stringify(input.bcc ?? []),
        input.subject,
        input.html ?? null,
        input.text ?? null,
        createdAt,
      );
      return db.prepare("SELECT * FROM outbound_messages WHERE id = ?").get(id) as OutboundRow;
    },

    findById(tenantId: string, id: string): OutboundRow | undefined {
      return db
        .prepare("SELECT * FROM outbound_messages WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL")
        .get(tenantId, id) as OutboundRow | undefined;
    },

    /** Looks up by global id; call only after a tenant-scoped lookup or ownership check. */
    findGlobal(id: string): OutboundRow | undefined {
      return db.prepare("SELECT * FROM outbound_messages WHERE id = ? AND deleted_at IS NULL").get(id) as
        | OutboundRow
        | undefined;
    },

    markSent(id: string, resendMessageId: string, deliveredAtIso: string): void {
      db.prepare(
        `UPDATE outbound_messages
         SET status = 'sent', message_id = ?, delivered_at = ?, error = NULL
         WHERE id = ? AND status IN ('pending', 'failed')`,
      ).run(resendMessageId, deliveredAtIso, id);
    },

    markBounced(id: string, error: string): void {
      db.prepare(
        `UPDATE outbound_messages
         SET status = 'bounced', error = ?
         WHERE id = ? AND status IN ('pending', 'sent', 'failed')`,
      ).run(error.slice(0, 1000), id);
    },

    markFailed(id: string, error: string): void {
      db.prepare("UPDATE outbound_messages SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'").run(
        error.slice(0, 1000),
        id,
      );
    },

    softDelete(tenantId: string, id: string): boolean {
      const result = db
        .prepare("UPDATE outbound_messages SET deleted_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL")
        .run(new Date().toISOString(), tenantId, id);
      return result.changes > 0;
    },

    listByTenant: list,
    findPending(limit = 25): OutboundRow[] {
      return db
        .prepare("SELECT * FROM outbound_messages WHERE status = 'pending' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT ?")
        .all(limit) as OutboundRow[];
    },
  };
}

export function createOutboundDeliveriesRepo(db: Database.Database): OutboundDeliveriesRepo {
  const nowIso = (value?: string) => value ?? new Date().toISOString();
  return {
    create({ messageId, nextAttemptAt, status = "pending" }) {
      const id = newId();
      const at = nowIso();
      db.prepare(
        `INSERT INTO outbound_deliveries (id, message_id, next_attempt_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, messageId, nextAttemptAt ?? at, status, at, at);
      return { id };
    },

    /**
     * Atomically claims a pending delivery for processing by updating its
     * status to a special 'in_flight' state. Returns true if the claim
     * succeeded (row was pending and due), false otherwise. This prevents
     * the background dispatcher from picking up a delivery that the
     * synchronous route is already attempting.
     */
    claimForAttempt(id: string, nowIsoValue?: string): boolean {
      const now = nowIso(nowIsoValue);
      const result = db
        .prepare(
          `UPDATE outbound_deliveries
           SET status = 'in_flight', updated_at = ?
           WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
        )
        .run(now, id, now);
      return result.changes > 0;
    },

    findDue(nowIsoValue, limit) {
      return db
        .prepare(
          `SELECT * FROM outbound_deliveries
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY next_attempt_at ASC, id ASC LIMIT ?`,
        )
        .all(nowIsoValue, limit) as Array<{
        id: string;
        message_id: string;
        resend_message_id: string | null;
        attempts: number;
        next_attempt_at: string;
        status: OutboundDeliveryStatus;
      }>;
    },

    findByMessage(messageId) {
      return db
        .prepare(
          `SELECT * FROM outbound_deliveries WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(messageId) as
        | {
            id: string;
            message_id: string;
            resend_message_id: string | null;
            attempts: number;
            next_attempt_at: string;
            status: OutboundDeliveryStatus;
            last_error: string | null;
          }
        | undefined;
    },

    markDelivered(id, resendMessageId, at) {
      db.prepare(
        `UPDATE outbound_deliveries
         SET status = 'delivered', resend_message_id = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(resendMessageId, nowIso(at), id);
    },

    markBounced(id, error, at) {
      db.prepare(
        `UPDATE outbound_deliveries SET status = 'bounced', last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(error.slice(0, 1000), nowIso(at), id);
    },

    markAttempt(id, attempts, error, nextAttemptAtIso, at) {
      db.prepare(
        `UPDATE outbound_deliveries
         SET attempts = ?, last_error = ?, next_attempt_at = ?, status = 'pending', updated_at = ?
         WHERE id = ?`,
      ).run(attempts, error.slice(0, 1000), nextAttemptAtIso, nowIso(at), id);
    },

    markDead(id, attempts, error, at) {
      db.prepare(
        `UPDATE outbound_deliveries
         SET status = 'dead', attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(attempts, error.slice(0, 1000), nowIso(at), id);
    },
  };
}
