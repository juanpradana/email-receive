import { createHash, randomUUID } from "node:crypto";
import { createMessagesRepo } from "../db/repo/messages.js";
import { createTenantsRepo } from "../db/repo/tenants.js";
import type { Storage } from "./storage.js";

export class IngestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IngestInput {
  bytes: Buffer;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt?: string;
  source?: string;
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
}

export function recipientDomain(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1) throw new IngestError(400, "invalid_envelope_to");
  return address.slice(at + 1).trim().toLowerCase();
}

export interface IngestService {
  ingest(input: IngestInput, now?: Date): Promise<IngestResult>;
}

export function createIngestService(deps: {
  db: import("better-sqlite3").Database;
  storage: Storage;
  dedupeWindowHours: number;
  maxMessageBytes: number;
}): IngestService {
  const tenants = createTenantsRepo(deps.db);
  const messages = createMessagesRepo(deps.db);

  return {
    async ingest(input, now = new Date()) {
      if (input.bytes.length === 0) throw new IngestError(400, "empty_body");
      if (input.bytes.length > deps.maxMessageBytes) throw new IngestError(413, "message_too_large");

      const domain = recipientDomain(input.envelopeTo);
      const tenant = tenants.findByDomain(domain);
      if (!tenant) throw new IngestError(404, "recipient_domain_not_registered");

      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const windowStart = new Date(now.getTime() - deps.dedupeWindowHours * 3_600_000).toISOString();
      const id = randomUUID();
      const rawPath = await deps.storage.putRaw(id, input.bytes);
      let inserted: { row: { id: string }; duplicate: boolean };
      try {
        // Check and insert share one synchronous transaction, so two worker
        // retries that reach this point together cannot both create a row.
        inserted = messages.insertIfNew(
          {
            id,
            tenantId: tenant.id,
            envelopeFrom: input.envelopeFrom,
            envelopeTo: input.envelopeTo,
            recipientDomain: domain,
            sha256,
            receivedAt: input.receivedAt ?? now.toISOString(),
            sizeBytes: input.bytes.length,
            rawPath,
          },
          windowStart,
        );
      } catch (error) {
        await deps.storage.delete(rawPath).catch(() => undefined);
        throw error;
      }
      if (inserted.duplicate) {
        await deps.storage.delete(rawPath).catch(() => undefined);
        return { id: inserted.row.id, duplicate: true };
      }
      return { id, duplicate: false };
    },
  };
}