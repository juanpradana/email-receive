import type Database from "better-sqlite3";
import { newId } from "../client.js";

export interface Tenant {
  id: string;
  name: string;
  created_at: string;
}

export interface TenantsRepo {
  createTenant(name: string): Tenant;
  addDomain(tenantId: string, domain: string): void;
  findByDomain(domain: string): Tenant | undefined;
  findById(id: string): Tenant | undefined;
  list(): Tenant[];
  listDomains(tenantId: string): string[];
}

export function createTenantsRepo(db: Database.Database): TenantsRepo {
  return {
    createTenant(name) {
      const tenant: Tenant = { id: newId(), name, created_at: new Date().toISOString() };
      db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(
        tenant.id,
        tenant.name,
        tenant.created_at,
      );
      return tenant;
    },

    addDomain(tenantId, domain) {
      db.prepare("INSERT INTO tenant_domains (domain, tenant_id, created_at) VALUES (?, ?, ?)").run(
        domain.trim().toLowerCase(),
        tenantId,
        new Date().toISOString(),
      );
    },

    findByDomain(domain) {
      return db
        .prepare(
          `SELECT t.* FROM tenants t
           JOIN tenant_domains d ON d.tenant_id = t.id
           WHERE d.domain = ?`,
        )
        .get(domain.trim().toLowerCase()) as Tenant | undefined;
    },

    findById(id) {
      return db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Tenant | undefined;
    },

    list() {
      return db.prepare("SELECT * FROM tenants ORDER BY created_at ASC, id ASC").all() as Tenant[];
    },

    listDomains(tenantId) {
      return (
        db
          .prepare("SELECT domain FROM tenant_domains WHERE tenant_id = ? ORDER BY domain")
          .all(tenantId) as Array<{ domain: string }>
      ).map((row) => row.domain);
    },
  };
}