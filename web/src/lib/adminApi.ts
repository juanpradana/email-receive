export interface AdminSession {
  token: string;
  baseUrl: string;
}

export interface AdminTenant {
  id: string;
  name: string;
  domains: string[];
  createdAt: string;
}

export interface AdminApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AdminKeyCreation {
  apiKey: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    plaintext: string;
  };
}

export interface UserSetup {
  tenantId: string;
  tenantName: string;
  domain: string;
  baseUrl: string;
  apiKey: string;
  fromAddr: string;
}

export async function adminRequest(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  }
  return json;
}

export function loadAdminSession(): AdminSession | null {
  try {
    const token = localStorage.getItem("admin.token");
    const baseUrl = localStorage.getItem("admin.baseUrl");
    if (!token || !baseUrl) return null;
    return { token, baseUrl: baseUrl.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

export function saveAdminSession(session: AdminSession): void {
  try {
    localStorage.setItem("admin.token", session.token);
    localStorage.setItem("admin.baseUrl", session.baseUrl.replace(/\/+$/, ""));
  } catch {
    // localStorage unavailable
  }
}

export function clearAdminSession(): void {
  try {
    localStorage.removeItem("admin.token");
    localStorage.removeItem("admin.baseUrl");
  } catch {
    // Ignore
  }
}

export async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const json = (await adminRequest(baseUrl, "", "POST", "/v1/admin/login", { email, password })) as {
    adminSessionToken: string;
  };
  return json.adminSessionToken;
}

export async function logout(session: AdminSession): Promise<void> {
  try {
    await adminRequest(session.baseUrl, session.token, "POST", "/v1/admin/logout");
  } finally {
    clearAdminSession();
  }
}

export async function listTenants(session: AdminSession): Promise<AdminTenant[]> {
  const json = (await adminRequest(session.baseUrl, session.token, "GET", "/v1/admin/tenants")) as {
    tenants: AdminTenant[];
  };
  return json.tenants;
}

export async function createTenant(session: AdminSession, name: string): Promise<AdminTenant> {
  const json = (await adminRequest(
    session.baseUrl,
    session.token,
    "POST",
    "/v1/admin/tenants",
    { name },
  )) as { tenant: AdminTenant };
  return json.tenant;
}

export async function addDomain(
  session: AdminSession,
  tenantId: string,
  domain: string,
): Promise<void> {
  await adminRequest(
    session.baseUrl,
    session.token,
    "POST",
    `/v1/admin/tenants/${tenantId}/domains`,
    { domain },
  );
}

export async function listKeys(
  session: AdminSession,
  tenantId: string,
): Promise<AdminApiKey[]> {
  const json = (await adminRequest(
    session.baseUrl,
    session.token,
    "GET",
    `/v1/admin/tenants/${tenantId}/keys`,
  )) as { apiKeys: AdminApiKey[] };
  return json.apiKeys;
}

export async function createKey(
  session: AdminSession,
  tenantId: string,
  name: string,
  scopes: string[],
): Promise<AdminKeyCreation> {
  const json = (await adminRequest(
    session.baseUrl,
    session.token,
    "POST",
    `/v1/admin/tenants/${tenantId}/keys`,
    { name, scopes },
  )) as AdminKeyCreation;
  return json;
}

export async function revokeKey(
  session: AdminSession,
  tenantId: string,
  keyId: string,
): Promise<void> {
  await adminRequest(
    session.baseUrl,
    session.token,
    "DELETE",
    `/v1/admin/tenants/${tenantId}/keys/${keyId}`,
  );
}
