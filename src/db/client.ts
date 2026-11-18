import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function newId(): string {
  return randomUUID();
}