import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/client.js";
import { createApiKeysRepo } from "../../src/db/repo/apiKeys.js";
import { createTenantsRepo } from "../../src/db/repo/tenants.js";
import { generateApiKey, hashApiKey, verifyApiKey } from "../../src/auth/apiKey.js";

let db: Database.Database;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("api keys", () => {
  it("stores only a hash and verifies the plaintext key", () => {
    const keys = createApiKeysRepo(db);
    const tenants = createTenantsRepo(db);
    const tenant = tenants.createTenant("Acme");
    const generated = generateApiKey();
    const row = keys.create({
      tenantId: tenant.id,
      name: "default",
      prefix: generated.prefix,
      keyHash: hashApiKey(generated.plaintext),
      scopes: ["read"],
    });
    expect(row.key_hash).not.toBe(generated.plaintext);
    expect(row.key_hash).not.toContain(generated.plaintext);
    expect(verifyApiKey(generated.plaintext, row.key_hash)).toBe(true);
    expect(verifyApiKey(`${generated.plaintext}x`, row.key_hash)).toBe(false);
  });

  it("does not resolve revoked keys", () => {
    const keys = createApiKeysRepo(db);
    const tenants = createTenantsRepo(db);
    const tenant = tenants.createTenant("Acme");
    const generated = generateApiKey();
    const row = keys.create({
      tenantId: tenant.id,
      name: "default",
      prefix: generated.prefix,
      keyHash: hashApiKey(generated.plaintext),
      scopes: ["read"],
    });
    expect(keys.revoke(tenant.id, row.id)).toBe(true);
    expect(keys.findActiveByPrefix(generated.prefix)).toHaveLength(0);
  });

  // 50 scrypt derivations need headroom when the full suite occupies every worker.
  it("generates keys that do not collide", { timeout: 30_000 }, () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const key = generateApiKey();
      expect(key.prefix).toHaveLength(8);
      expect(seen.has(key.plaintext)).toBe(false);
      seen.add(key.plaintext);
    }
  });
});