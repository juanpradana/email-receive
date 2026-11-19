import { useState, useEffect, useCallback } from "react";
import type * as React from "react";
import {
  loadAdminSession,
  logout,
  listTenants,
  createTenant,
  addDomain,
  listKeys,
  createKey,
  revokeKey,
  type AdminSession,
  type AdminTenant,
  type AdminApiKey,
} from "../../lib/adminApi.js";

type Tab = "tenants" | "setup";

export function AdminDashboard() {
  const [session, setSession] = useState<AdminSession | null>(() => loadAdminSession());
  const [tab, setTab] = useState<Tab>("tenants");
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<AdminTenant | null>(null);
  const [keys, setKeys] = useState<AdminApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // New tenant form
  const [newTenantName, setNewTenantName] = useState("");
  // Add domain form
  const [newDomain, setNewDomain] = useState("");
  // New key form
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(["read"]);

  async function refreshTenants() {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const t = await listTenants(session);
      setTenants(t);
      if (selectedTenant && t.length > 0) {
        const updated = t.find((x) => x.id === selectedTenant.id);
        if (updated) setSelectedTenant(updated);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }

  async function refreshKeys(tenantId: string) {
    if (!session) return;
    try {
      const k = await listKeys(session, tenantId);
      setKeys(k);
    } catch {
      setKeys([]);
    }
  }

  useEffect(() => {
    void refreshTenants();
  }, [session]);

  useEffect(() => {
    if (selectedTenant) void refreshKeys(selectedTenant.id);
    else setKeys([]);
  }, [selectedTenant?.id]);

  if (!session) {
    window.location.href = "/admin";
    return null;
  }

  function show(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleCreateTenant(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !newTenantName.trim()) return;
    try {
      const t = await createTenant(session, newTenantName.trim());
      setNewTenantName("");
      show(`Tenant "${t.name}" created`);
      await refreshTenants();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to create tenant");
    }
  }

  async function handleAddDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !selectedTenant || !newDomain.trim()) return;
    try {
      await addDomain(session, selectedTenant.id, newDomain.trim());
      setNewDomain("");
      show(`Domain "${newDomain.trim()}" added`);
      await refreshTenants();
      if (selectedTenant) setSelectedTenant({ ...selectedTenant });
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Failed to add domain";
      if (msg.includes("409")) setError("Domain already registered");
      else setError(msg);
    }
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !selectedTenant || !newKeyName.trim()) return;
    try {
      const result = await createKey(session, selectedTenant.id, newKeyName.trim(), newKeyScopes);
      setNewKeyName("");
      setNewKeyScopes(["read"]);
      show(`Key "${result.apiKey.name}" created`);
      await refreshKeys(selectedTenant.id);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to create key");
    }
  }

  async function handleRevokeKey(keyId: string) {
    if (!session || !selectedTenant) return;
    try {
      await revokeKey(session, selectedTenant.id, keyId);
      show("Key revoked");
      await refreshKeys(selectedTenant.id);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to revoke key");
    }
  }

  async function handleLogout() {
    if (session) await logout(session);
    setSession(null);
    window.location.href = "/";
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>Admin</h1>
          <nav style={styles.nav}>
            <button
              onClick={() => setTab("tenants")}
              style={{ ...styles.navLink, ...(tab === "tenants" ? styles.navLinkActive : {}) }}
            >
              Tenants
            </button>
            <button
              onClick={() => setTab("setup")}
              style={{ ...styles.navLink, ...(tab === "setup" ? styles.navLinkActive : {}) }}
            >
              User Setup
            </button>
          </nav>
        </div>
        <button onClick={() => void handleLogout()} style={styles.logoutBtn}>
          Logout
        </button>
      </header>

      {toast && <div style={styles.toast}>{toast}</div>}
      {error && (
        <div style={styles.errorBar}>
          {error}
          <button onClick={() => setError(null)} style={styles.errorClose}>
            ×
          </button>
        </div>
      )}

      {tab === "tenants" && (
        <main style={styles.main}>
          {/* Create tenant */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Create Tenant</h2>
            <form onSubmit={handleCreateTenant} style={styles.inlineForm}>
              <input
                value={newTenantName}
                onChange={(e) => setNewTenantName(e.target.value)}
                placeholder="Tenant name (e.g. Farzani)"
                style={styles.input}
              />
              <button type="submit" disabled={!newTenantName.trim()} style={styles.primaryBtn}>
                Create
              </button>
            </form>
          </section>

          {/* Tenant list */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Tenants</h2>
            {tenants.length === 0 ? (
              <p style={styles.empty}>{loading ? "Loading…" : "No tenants yet. Create one above."}</p>
            ) : (
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Name</th>
                      <th style={styles.th}>Domains</th>
                      <th style={styles.th}>Keys</th>
                      <th style={styles.th}>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => setSelectedTenant(t)}
                        style={{
                          ...styles.tr,
                          ...(selectedTenant?.id === t.id ? styles.trSelected : {}),
                        }}
                      >
                        <td style={styles.td}>{t.name}</td>
                        <td style={styles.td}>{t.domains.join(", ") || "—"}</td>
                        <td style={styles.td}>{selectedTenant?.id === t.id ? keys.length : "…"}</td>
                        <td style={styles.td}>{new Date(t.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Selected tenant detail */}
          {selectedTenant && (
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>{selectedTenant.name}</h2>

              {/* Add domain */}
              <form onSubmit={handleAddDomain} style={styles.inlineForm}>
                <input
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="example.com"
                  style={{ ...styles.input, maxWidth: "240px" }}
                />
                <button type="submit" disabled={!newDomain.trim()} style={styles.primaryBtn}>
                  Add Domain
                </button>
              </form>

              {/* Keys table */}
              {keys.length > 0 && (
                <div style={{ ...styles.tableWrap, marginTop: "0.75rem" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Name</th>
                        <th style={styles.th}>Prefix</th>
                        <th style={styles.th}>Scopes</th>
                        <th style={styles.th}>Status</th>
                        <th style={styles.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k) => (
                        <tr key={k.id}>
                          <td style={styles.td}>{k.name}</td>
                          <td style={{ ...styles.td, fontFamily: "monospace" }}>{k.prefix}…</td>
                          <td style={styles.td}>{k.scopes.join(", ")}</td>
                          <td style={styles.td}>
                            {k.revokedAt ? (
                              <span style={styles.badgeRed}>Revoked</span>
                            ) : (
                              <span style={styles.badgeGreen}>Active</span>
                            )}
                          </td>
                          <td style={styles.td}>
                            {!k.revokedAt && (
                              <button
                                onClick={() => void handleRevokeKey(k.id)}
                                style={styles.dangerBtn}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Create key */}
              <form onSubmit={handleCreateKey} style={{ ...styles.inlineForm, marginTop: "0.75rem" }}>
                <input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Key name"
                  style={{ ...styles.input, maxWidth: "160px" }}
                />
                <label style={styles.scopeLabel}>
                  <input
                    type="checkbox"
                    checked={newKeyScopes.includes("read")}
                    onChange={(e) =>
                      setNewKeyScopes(
                        e.target.checked
                          ? [...newKeyScopes, "read"]
                          : newKeyScopes.filter((s) => s !== "read"),
                      )
                    }
                    style={styles.checkbox}
                  />
                  read
                </label>
                <label style={styles.scopeLabel}>
                  <input
                    type="checkbox"
                    checked={newKeyScopes.includes("admin")}
                    onChange={(e) =>
                      setNewKeyScopes(
                        e.target.checked
                          ? [...newKeyScopes, "admin"]
                          : newKeyScopes.filter((s) => s !== "admin"),
                      )
                    }
                    style={styles.checkbox}
                  />
                  admin
                </label>
                <button
                  type="submit"
                  disabled={!newKeyName.trim() || newKeyScopes.length === 0}
                  style={styles.primaryBtn}
                >
                  Create Key
                </button>
              </form>
            </section>
          )}
        </main>
      )}

      {tab === "setup" && <UserSetupPanel session={session} onCreated={(u) => {
        show(`User setup ready for ${u.fromAddr}`);
        setTab("tenants");
      }} />}
    </div>
  );
}

function UserSetupPanel({
  session,
  onCreated,
}: {
  session: AdminSession;
  onCreated: (u: { fromAddr: string }) => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [domain, setDomain] = useState("");
  const [fromAddr, setFromAddr] = useState("");
  const [result, setResult] = useState<{ baseUrl: string; apiKey: string; fromAddr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void listTenants(session).then(setTenants).catch(() => setTenants([]));
  }, [session]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId || !domain.trim() || !fromAddr.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await addDomain(session, tenantId, domain.trim());
      const keyRes = await createKey(session, tenantId, "user-key", ["read", "admin"]);
      const baseUrl = window.location.origin;
      setResult({ baseUrl, apiKey: keyRes.apiKey.plaintext, fromAddr: fromAddr.trim() });
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Failed to create user setup");
    } finally {
      setLoading(false);
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => onCreated({ fromAddr: fromAddr.trim() }),
      () => console.error(`Failed to copy ${label}`),
    );
  }

  const tenant = tenants.find((t) => t.id === tenantId);

  return (
    <main style={styles.main}>
      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Create Mailbox User</h2>
        <p style={styles.help}>
          Set up a user by selecting a tenant, adding a domain, and generating an API key.
          The key is shown once — copy it now.
        </p>

        <form onSubmit={handleGenerate} style={styles.columnForm}>
          <label style={styles.label}>
            Tenant
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={styles.select}>
              <option value="">Select tenant…</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.label}>
            Domain
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="farzani.my.id"
              style={styles.input}
            />
          </label>

          <label style={styles.label}>
            Default From address
            <input
              value={fromAddr}
              onChange={(e) => setFromAddr(e.target.value)}
              placeholder={`me@${domain || "example.com"}`}
              style={styles.input}
            />
          </label>

          <button
            type="submit"
            disabled={loading || !tenantId || !domain.trim() || !fromAddr.trim()}
            style={styles.primaryBtn}
          >
            {loading ? "Creating…" : "Generate User Key"}
          </button>
        </form>

        {error && <div style={styles.error}>{error}</div>}

        {result && (
          <div style={styles.resultCard}>
            <h3 style={styles.resultTitle}>User credentials</h3>
            <div style={styles.resultRow}>
              <span style={styles.resultLabel}>Base URL</span>
              <code style={styles.code}>{result.baseUrl}</code>
            </div>
            <div style={styles.resultRow}>
              <span style={styles.resultLabel}>API Key</span>
              <div style={styles.keyRow}>
                <code style={styles.code}>{result.apiKey}</code>
                <button onClick={() => copyToClipboard(result.apiKey, "API key")} style={styles.copyBtn}>
                  Copy
                </button>
              </div>
            </div>
            <div style={styles.resultRow}>
              <span style={styles.resultLabel}>From</span>
              <code style={styles.code}>{result.fromAddr}</code>
            </div>
            <p style={styles.resultHint}>
              Share these with the user. They can paste them into the webmail Settings page.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, sans-serif",
    background: "#f9fafb",
  },
  header: {
    padding: "0.75rem 1.5rem",
    borderBottom: "1px solid #e5e7eb",
    background: "white",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: "1rem" },
  title: { margin: 0, fontSize: "1.25rem", color: "#111827" },
  nav: { display: "flex", gap: "0.5rem" },
  navLink: {
    padding: "0.4rem 0.75rem",
    border: "1px solid #e5e7eb",
    borderRadius: "0.375rem",
    background: "white",
    cursor: "pointer",
    fontSize: "0.9rem",
    color: "#374151",
  },
  navLinkActive: {
    background: "#2563eb",
    color: "white",
    border: "1px solid #2563eb",
  },
  logoutBtn: {
    padding: "0.4rem 0.75rem",
    border: "1px solid #e5e7eb",
    borderRadius: "0.375rem",
    background: "white",
    cursor: "pointer",
    fontSize: "0.9rem",
    color: "#6b7280",
  },
  main: { flex: 1, padding: "1.5rem", maxWidth: "900px", margin: "0 auto", width: "100%", boxSizing: "border-box" },
  section: { marginBottom: "1.5rem", background: "white", border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "1.25rem" },
  sectionTitle: { margin: "0 0 0.75rem", fontSize: "1rem", color: "#111827" },
  help: { margin: "0 0 0.75rem", fontSize: "0.85rem", color: "#6b7280" },
  inlineForm: { display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" },
  columnForm: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  input: {
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.375rem",
    fontFamily: "inherit",
    fontSize: "0.9rem",
    minWidth: "200px",
  },
  select: {
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.375rem",
    fontFamily: "inherit",
    fontSize: "0.9rem",
    background: "white",
    minWidth: "200px",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontSize: "0.85rem",
    color: "#374151",
    fontWeight: 500,
  },
  primaryBtn: {
    padding: "0.5rem 1rem",
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.9rem",
    fontWeight: 500,
  },
  dangerBtn: {
    padding: "0.3rem 0.6rem",
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  copyBtn: {
    padding: "0.3rem 0.6rem",
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #e5e7eb",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" },
  th: {
    padding: "0.5rem 0.75rem",
    textAlign: "left",
    borderBottom: "2px solid #e5e7eb",
    color: "#6b7280",
    fontWeight: 600,
    fontSize: "0.8rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  tr: { cursor: "pointer", borderBottom: "1px solid #f3f4f6" },
  trSelected: { background: "#eff6ff" },
  td: { padding: "0.5rem 0.75rem", color: "#374151" },
  empty: { color: "#6b7280", fontSize: "0.9rem", padding: "0.5rem 0" },
  badgeGreen: {
    display: "inline-block",
    padding: "0.15rem 0.5rem",
    background: "#f0fdf4",
    color: "#166534",
    borderRadius: "9999px",
    fontSize: "0.75rem",
    fontWeight: 500,
  },
  badgeRed: {
    display: "inline-block",
    padding: "0.15rem 0.5rem",
    background: "#fef2f2",
    color: "#991b1b",
    borderRadius: "9999px",
    fontSize: "0.75rem",
    fontWeight: 500,
  },
  scopeLabel: { display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.85rem", color: "#374151" },
  checkbox: { margin: 0 },
  toast: {
    position: "fixed",
    bottom: "1.5rem",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "0.6rem 1.2rem",
    background: "#166534",
    color: "white",
    borderRadius: "0.375rem",
    fontSize: "0.9rem",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: 100,
  },
  errorBar: {
    padding: "0.5rem 1.5rem",
    background: "#fef2f2",
    color: "#991b1b",
    fontSize: "0.85rem",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  errorClose: {
    background: "none",
    border: "none",
    color: "#991b1b",
    fontSize: "1.2rem",
    cursor: "pointer",
    lineHeight: 1,
  },
  error: {
    padding: "0.5rem 0.75rem",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "0.375rem",
    fontSize: "0.85rem",
    color: "#991b1b",
    marginTop: "0.5rem",
  },
  resultCard: {
    marginTop: "1rem",
    padding: "1rem",
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    borderRadius: "0.5rem",
  },
  resultTitle: { margin: "0 0 0.75rem", fontSize: "0.95rem", color: "#166534" },
  resultRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.4rem 0",
    borderBottom: "1px solid #bbf7d0",
    gap: "0.5rem",
  },
  resultLabel: { fontSize: "0.85rem", color: "#166534", fontWeight: 500, flexShrink: 0 },
  code: {
    fontFamily: "monospace",
    fontSize: "0.85rem",
    background: "white",
    padding: "0.2rem 0.5rem",
    borderRadius: "0.25rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  keyRow: { display: "flex", gap: "0.5rem", alignItems: "center", flex: 1, minWidth: 0 },
  resultHint: { margin: "0.75rem 0 0", fontSize: "0.8rem", color: "#166534" },
};
