import { useState } from "react";
import { useApp } from "../App.js";

/**
 * Connection settings. The API key is the tenant key from the API's admin
 * endpoint and is the only credential the browser holds. It is never sent
 * anywhere except as the `Authorization` header on requests to `baseUrl`.
 */
export function Settings({ onSubmit }: { onSubmit: (page: "inbox") => void }) {
  const { mailbox, setMailbox } = useApp();
  const [baseUrl, setBaseUrl] = useState(mailbox?.baseUrl ?? window.location.origin);
  const [apiKey, setApiKey] = useState(mailbox?.apiKey ?? "");
  const [fromAddr, setFromAddr] = useState(mailbox?.fromAddr ?? "");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!baseUrl.trim() || !apiKey.trim()) return;
    setMailbox({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), fromAddr: fromAddr.trim() });
    onSubmit("inbox");
  }

  function disconnect() {
    setMailbox(null);
    setApiKey("");
  }

  return (
    <div style={styles.wrap}>
      <form onSubmit={submit} style={styles.card}>
        <h2 style={styles.heading}>Connect to your mailbox</h2>
        <p style={styles.help}>
          Enter the API base URL and a tenant API key. The key stays in this browser's localStorage.
        </p>
        <label style={styles.label}>
          API base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mail.example.com" style={styles.input} />
        </label>
        <label style={styles.label}>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="ek_…"
            autoComplete="off"
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Default From address
          <input value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} placeholder="me@example.com" style={styles.input} />
        </label>
        <div style={styles.actions}>
          <button type="submit" style={styles.primary} disabled={!baseUrl.trim() || !apiKey.trim()}>
            Connect
          </button>
          {mailbox && (
            <button type="button" onClick={disconnect} style={styles.secondary}>
              Disconnect
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", justifyContent: "center", padding: "2rem 1rem" },
  card: { width: "100%", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "0.75rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "1.5rem", background: "white" },
  heading: { margin: 0 },
  help: { margin: 0, fontSize: "0.85rem", color: "#6b7280" },
  label: { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem", color: "#374151" },
  input: { padding: "0.5rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", fontFamily: "inherit" },
  actions: { display: "flex", gap: "0.75rem", marginTop: "0.5rem" },
  primary: { padding: "0.45rem 0.9rem", background: "#2563eb", color: "white", border: "none", borderRadius: "0.25rem", cursor: "pointer" },
  secondary: { padding: "0.45rem 0.9rem", background: "white", color: "#374151", border: "1px solid #e5e7eb", borderRadius: "0.25rem", cursor: "pointer" },
};