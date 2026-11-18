import type Database from "better-sqlite3";
import { newId } from "../client.js";

export type ApiScope = "read" | "admin";

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeysRepo {
  create(input: { tenantId: string; name: string; prefix: string; keyHash: string; scopes: ApiScope[] }): ApiKeyRow;
  listByTenant(tenantId: string): ApiKeyRow[];
  findActiveByPrefix(prefix: string): ApiKeyRow[];
  touch(id: string): void;
  revoke(tenantId: string, id: string): boolean;
}

export function createApiKeysRepo(db: Database.Database): ApiKeysRepo {
  return {
    create({ tenantId, name, prefix, keyHash, scopes }) {
      const row: ApiKeyRow = {
        id: newId(),
        tenant_id: tenantId,
        name,
        prefix,
        key_hash: keyHash,
        scopes_json: JSON.stringify(scopes),
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      db.prepare(
        `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, scopes_json, created_at)
         VALUES (@id, @tenant_id, @name, @prefix, @key_hash, @scopes_json, @created_at)`,
      ).run(row);
      return row;
    },

    listByTenant(tenantId) {
      return db
        .prepare("SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC")
        .all(tenantId) as ApiKeyRow[];
    },

    findActiveByPrefix(prefix) {
      return db
        .prepare("SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL")
        .all(prefix) as ApiKeyRow[];
    },

    touch(id) {
      db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    },

    revoke(tenantId, id) {
      const result = db
        .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), id, tenantId);
      return result.changes > 0;
    },
  };
}