import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeysRepo, ApiScope } from "../db/repo/apiKeys.js";

const KEY_PREFIX = "ek_";
const SCRYPT_KEYLEN = 32;

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

export interface AuthContext {
  tenantId: string;
  keyId: string;
  scopes: ApiScope[];
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

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}