import { useState, useEffect } from "react";
import { useApp } from "../App.js";
import { listMessages } from "../lib/api.js";

function parseUrlParams(): { baseUrl?: string; apiKey?: string; fromAddr?: string } {
  try {
    const params = new URLSearchParams(window.location.search);
    const baseUrl = params.get("baseUrl") ?? undefined;
    const apiKey = params.get("apiKey") ?? undefined;
    const fromAddr = params.get("fromAddr") ?? undefined;
    return { baseUrl, apiKey, fromAddr };
  } catch {
    return {};
  }
}

export function Settings({ onSubmit }: { onSubmit: (page: "inbox") => void }) {
  const { mailbox, setMailbox } = useApp();
  const urlParams = parseUrlParams();

  const [baseUrl, setBaseUrl] = useState(
    urlParams.baseUrl ?? mailbox?.baseUrl ?? window.location.origin,
  );
  const [apiKey, setApiKey] = useState(urlParams.apiKey ?? mailbox?.apiKey ?? "");
  const [fromAddr, setFromAddr] = useState(urlParams.fromAddr ?? mailbox?.fromAddr ?? "");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  // Clear URL params after loading so refresh doesn't re-apply them
  useEffect(() => {
    if (urlParams.baseUrl || urlParams.apiKey || urlParams.fromAddr) {
      const url = window.location.pathname;
      window.history.replaceState({}, "", url);
    }
  }, []);

  async function testConnection() {
    if (!baseUrl.trim() || !apiKey.trim()) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      await listMessages({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), fromAddr: fromAddr.trim() }, 1);
      setTestStatus("ok");
    } catch (e) {
      setTestStatus("fail");
      setTestError(e instanceof Error ? e.message : "Connection failed");
    }
  }

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
          Enter your API base URL and tenant API key. The key is stored only in this
          browser's localStorage — it is never sent anywhere except as an authorization
          header to your own server.
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

        {testStatus === "testing" && (
          <div style={styles.testStatus}>Testing connection…</div>
        )}
        {testStatus === "ok" && (
          <div style={{ ...styles.testStatus, ...styles.testOk }}>✓ Connection OK</div>
        )}
        {testStatus === "fail" && (
          <div style={{ ...styles.testStatus, ...styles.testFail }}>
            ✗ {testError}
          </div>
        )}

        <div style={styles.actions}>
          <button type="submit" style={styles.primary} disabled={!baseUrl.trim() || !apiKey.trim()}>
            Connect
          </button>
          <button
            type="button"
            onClick={() => void testConnection()}
            style={styles.secondary}
            disabled={testStatus === "testing" || !baseUrl.trim() || !apiKey.trim()}
          >
            Test connection
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
  card: { width: "100%", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "0.75rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "1.5rem", background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" },
  heading: { margin: 0 },
  help: { margin: 0, fontSize: "0.85rem", color: "#6b7280", lineHeight: 1.4 },
  label: { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem", color: "#374151", fontWeight: 500 },
  input: { padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: "0.375rem", fontFamily: "inherit", fontSize: "0.9rem" },
  actions: { display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" },
  primary: { padding: "0.45rem 0.9rem", background: "#2563eb", color: "white", border: "none", borderRadius: "0.375rem", cursor: "pointer", fontSize: "0.9rem", fontWeight: 500 },
  secondary: { padding: "0.45rem 0.9rem", background: "white", color: "#374151", border: "1px solid #d1d5db", borderRadius: "0.375rem", cursor: "pointer", fontSize: "0.9rem" },
  testStatus: { padding: "0.4rem 0.75rem", borderRadius: "0.375rem", fontSize: "0.85rem" },
  testOk: { background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0" },
  testFail: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" },
};
