import { useEffect, useState } from "react";
import { useApp } from "../App.js";
import { getMessage } from "../lib/api.js";
import type { MessageDetail } from "../lib/types.js";
import { ReplyForm } from "./ReplyForm.js";

export function Read({ messageId }: { messageId: string }) {
  const { mailbox, setPage } = useApp();
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mailbox) return;
    let cancelled = false;

    async function load(m: NonNullable<typeof mailbox>) {
      try {
        setLoading(true);
        const detail = await getMessage(m, messageId);
        if (!cancelled) setMessage(detail);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load message");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(mailbox);
    return () => {
      cancelled = true;
    };
  }, [mailbox, messageId]);

  if (loading) return <div>Loading…</div>;
  if (error) return <div style={styles.error}>{error}</div>;
  if (!message) return <div>Message not found.</div>;

  return (
    <div>
      <button onClick={() => setPage("inbox")} style={styles.back}>
        ← Back
      </button>
      <h2 style={styles.subject}>{message.subject || "(no subject)"}</h2>
      <div style={styles.meta}>
        <div>
          <strong>From:</strong> {message.fromName ? `${message.fromName} <${message.fromAddr}>` : message.fromAddr}
        </div>
        <div>
          <strong>To:</strong> {message.to.map((r) => r.address).join(", ")}
        </div>
        {message.cc.length > 0 && (
          <div>
            <strong>Cc:</strong> {message.cc.map((r) => r.address).join(", ")}
          </div>
        )}
        <div>
          <strong>Date:</strong> {new Date(message.receivedAt).toLocaleString()}
        </div>
      </div>

      {/* Render text/plain only. Inbound HTML is never injected: the API
          stores it for download only, which keeps this view XSS-safe. */}
      <pre style={styles.body}>{message.bodyText ?? "(no text content)"}</pre>

      <ReplyForm messageId={message.id} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  back: { background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0, marginBottom: "1rem" },
  subject: { marginTop: 0, marginBottom: "0.75rem" },
  meta: { fontSize: "0.85rem", color: "#4b5563", display: "flex", flexDirection: "column", gap: "0.15rem", marginBottom: "1rem" },
  body: { whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "0.375rem", padding: "1rem", fontFamily: "inherit", margin: 0 },

  error: { color: "#dc2626" },
};