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
});