import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { generateApiKey } from "../auth/apiKey.js";
import { createApiKeysRepo } from "../db/repo/apiKeys.js";
import { createTenantsRepo } from "../db/repo/tenants.js";

const createTenantBody = z.object({ name: z.string().trim().min(1).max(200) });
const addDomainBody = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "invalid domain"),
});
const createKeyBody = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(z.enum(["read", "admin"])).min(1).default(["read"]),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const tenants = () => createTenantsRepo(app.deps.db);
  const keys = () => createApiKeysRepo(app.deps.db);

  app.get("/v1/admin/tenants", async () => {
    const repo = tenants();
    return {
      tenants: repo.list().map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        domains: repo.listDomains(tenant.id),
        createdAt: tenant.created_at,
      })),
    };
  });

  app.post("/v1/admin/tenants", async (request, reply) => {
    const body = createTenantBody.parse(request.body);
    const tenant = tenants().createTenant(body.name);
    return reply.code(201).send({ tenant });
  });

  app.post("/v1/admin/tenants/:id/domains", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = addDomainBody.parse(request.body);
    const repo = tenants();
    if (!repo.findById(id)) {
      return reply.code(404).send({ error: "tenant_not_found" });
    }
    try {
      repo.addDomain(id, body.domain);
    } catch {
      return reply.code(409).send({ error: "domain_already_registered" });
    }
    return reply.code(201).send({ tenantId: id, domain: body.domain });
  });

  app.post("/v1/admin/tenants/:id/keys", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = createKeyBody.parse(request.body);
    if (!tenants().findById(id)) {
      return reply.code(404).send({ error: "tenant_not_found" });
    }
    const generated = generateApiKey();
    const row = keys().create({
      tenantId: id,
      name: body.name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      scopes: body.scopes,
    });
    return reply.code(201).send({
      apiKey: { id: row.id, name: row.name, prefix: row.prefix, scopes: body.scopes, plaintext: generated.plaintext },
    });
  });

  app.get("/v1/admin/tenants/:id/keys", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!tenants().findById(id)) {
      return reply.code(404).send({ error: "tenant_not_found" });
    }
    return {
      apiKeys: keys()
        .listByTenant(id)
        .map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          scopes: JSON.parse(row.scopes_json),
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
        })),
    };
  });

  app.delete("/v1/admin/tenants/:id/keys/:keyId", async (request, reply) => {
    const { id, keyId } = z.object({ id: z.string(), keyId: z.string() }).parse(request.params);
    const revoked = keys().revoke(id, keyId);
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: "key_not_found" });
  });
};