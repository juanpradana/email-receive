import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/client.js";

let db: Database.Database;
afterEach(() => db?.close());

describe("SQLite migrations", () => {
  it("can be applied repeatedly", () => {
    db = openDb(":memory:");
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toHaveLength(1);
  });

  it("creates the outbound schema on a database that predates it", () => {
    db = openDb(":memory:");
    migrate(db);
    // Simulate an older deployment: the versioned migrations ran, but the
    // outbound tables did not exist yet.
    db.exec(`
      DROP TABLE outbound_deliveries;
      DROP TABLE outbound_messages;
      DROP TABLE tenant_smtp_configs;
    `);
    expect(() => migrate(db)).not.toThrow();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["outbound_messages", "outbound_deliveries", "tenant_smtp_configs"]),
    );
  });
});