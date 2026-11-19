import { useState } from "react";
import type * as React from "react";
import { loadAdminSession, saveAdminSession, login, clearAdminSession } from "../../lib/adminApi.js";

export function AdminLogin() {
  const [baseUrl, setBaseUrl] = useState(
    loadAdminSession()?.baseUrl ?? window.location.origin,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!baseUrl.trim() || !email.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      const token = await login(baseUrl, email, password);
      saveAdminSession({ token, baseUrl: baseUrl.trim() });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.wrap}>
      <form onSubmit={submit} style={styles.card}>
        <h2 style={styles.heading}>Admin Login</h2>
        <p style={styles.help}>Sign in with your admin credentials.</p>
        {error && <div style={styles.error}>{error}</div>}
        <label style={styles.label}>
          API base URL
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://mail.example.com"
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={styles.input}
          />
        </label>
        <button
          type="submit"
          disabled={loading || !baseUrl.trim() || !email.trim() || !password}
          style={styles.primary}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
        <button
          type="button"
          onClick={() => {
            clearAdminSession();
            window.location.href = "/";
          }}
          style={styles.secondary}
        >
          Back to webmail
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    padding: "2rem 1rem",
    background: "#f9fafb",
  },
  card: {
    width: "100%",
    maxWidth: "380px",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    border: "1px solid #e5e7eb",
    borderRadius: "0.5rem",
    padding: "1.5rem",
    background: "white",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  },
  heading: { margin: 0, fontSize: "1.25rem", color: "#111827" },
  help: { margin: 0, fontSize: "0.85rem", color: "#6b7280" },
  error: {
    padding: "0.5rem 0.75rem",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "0.25rem",
    fontSize: "0.85rem",
    color: "#991b1b",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontSize: "0.85rem",
    color: "#374151",
    fontWeight: 500,
  },
  input: {
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.375rem",
    fontFamily: "inherit",
    fontSize: "0.95rem",
  },
  primary: {
    padding: "0.55rem 1rem",
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.95rem",
    fontWeight: 500,
    opacity: 0.6,
    pointerEvents: "none",
  },
  secondary: {
    padding: "0.45rem 0.9rem",
    background: "white",
    color: "#374151",
    border: "1px solid #d1d5db",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.9rem",
  },
};
