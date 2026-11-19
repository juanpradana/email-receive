import type Database from "better-sqlite3";

export interface AdminUserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface AdminUsersRepo {
  findByEmail(email: string): AdminUserRow | undefined;
  findById(id: string): AdminUserRow | undefined;
}

export function createAdminUsersRepo(db: Database.Database): AdminUsersRepo {
  return {
    findByEmail(email) {
      return db.prepare("SELECT * FROM admin_users WHERE email = ?").get(email) as AdminUserRow | undefined;
    },
    findById(id) {
      return db.prepare("SELECT * FROM admin_users WHERE id = ?").get(id) as AdminUserRow | undefined;
    },
  };
}

export interface AdminSessionRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface AdminSessionsRepo {
  create(userId: string, tokenHash: string, ttlMs: number): void;
  findActiveByTokenHash(tokenHash: string): AdminSessionRow | undefined;
  deleteByTokenHash(tokenHash: string): boolean;
}

export function createAdminSessionsRepo(db: Database.Database): AdminSessionsRepo {
  return {
    create(userId, tokenHash, ttlMs) {
      db.prepare(
        `INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).run(tokenHash, userId, new Date().toISOString(), new Date(Date.now() + ttlMs).toISOString());
    },
    findActiveByTokenHash(tokenHash) {
      const row = db
        .prepare("SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
        .get(tokenHash, new Date().toISOString()) as AdminSessionRow | undefined;
      return row;
    },
    deleteByTokenHash(tokenHash) {
      const result = db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
      return result.changes > 0;
    },
  };
}
