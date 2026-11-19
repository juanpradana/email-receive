import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { createAdminSessionsRepo, createAdminUsersRepo } from "../db/repo/adminUsers.js";
import { hashPassword, verifyPassword, generateSessionToken } from "./password.js";
import { newId } from "../db/client.js";
import type { ApiKeysRepo, ApiScope } from "../db/repo/apiKeys.js";

const KEY_PREFIX = "ek_";
const SCRYPT_KEYLEN = 32;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function hashApiKey(plaintext: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyApiKey(plaintext: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = scryptSync(plaintext, Buffer.from(saltHex, "hex"), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${KEY_PREFIX}${secret}`;
  return { plaintext, prefix: secret.slice(0, 8), hash: hashApiKey(plaintext) };
}

export function generateAdminSessionToken(): string {
  return generateSessionToken();
}

export function hashAdminSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthContext {
  tenantId: string;
  keyId: string;
  scopes: ApiScope[];
}

export interface AdminAuthContext {
  kind: "admin-session" | "legacy-token";
  userId?: string;
}

export interface ApiKeyGuard {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function bearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

export function createApiKeyGuard(keys: ApiKeysRepo): ApiKeyGuard {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request.headers.authorization);
    if (!token || !token.startsWith(KEY_PREFIX)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const prefix = token.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8);
    const candidates = keys.findActiveByPrefix(prefix);
    const match = candidates.find((row) => verifyApiKey(token, row.key_hash));
    if (!match) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    keys.touch(match.id);
    request.auth = {
      tenantId: match.tenant_id,
      keyId: match.id,
      scopes: JSON.parse(match.scopes_json) as ApiScope[],
    };
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth?.scopes.includes("admin")) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };

  return { authenticate, requireAdmin };
}

export function requireAdminToken(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request.headers.authorization);
    if (!token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}

export interface AdminAuthGuard {
  authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  login(email: string, password: string): Promise<string | null>;
  logout(token: string): Promise<boolean>;
  ensureBootstrapUser(email: string, password: string): void;
}

export function createAdminAuthGuard(db: Database.Database, legacyToken: string): AdminAuthGuard {
  const users = createAdminUsersRepo(db);
  const sessions = createAdminSessionsRepo(db);

  const authenticateAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request.headers.authorization);
    if (!token) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const legacy = Buffer.from(token);
    const legacyExpected = Buffer.from(legacyToken);
    if (legacy.length === legacyExpected.length && timingSafeEqual(legacy, legacyExpected)) {
      request.adminAuth = { kind: "legacy-token" };
      return;
    }

    const session = sessions.findActiveByTokenHash(hashAdminSessionToken(token));
    if (session) {
      request.adminAuth = { kind: "admin-session", userId: session.user_id };
      return;
    }

    await reply.code(401).send({ error: "unauthorized" });
  };

  const createSession = (userId: string, ttlMs: number) => {
    const token = generateSessionToken();
    sessions.create(userId, hashAdminSessionToken(token), ttlMs);
    return token;
  };

  const login = async (email: string, password: string): Promise<string | null> => {
    const user = users.findByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    return createSession(user.id, SESSION_TTL_MS);
  };

  const logout = async (token: string): Promise<boolean> => {
    return sessions.deleteByTokenHash(hashAdminSessionToken(token));
  };

  const ensureBootstrapUser = (email: string, password: string) => {
    const existing = users.findByEmail(email);
    if (existing) {
      db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
      return;
    }
    const id = newId();
    db.prepare("INSERT INTO admin_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      email,
      hashPassword(password),
      new Date().toISOString(),
    );
  };

  return { authenticateAdmin, login, logout, ensureBootstrapUser };
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
    adminAuth?: AdminAuthContext;
  }
}
