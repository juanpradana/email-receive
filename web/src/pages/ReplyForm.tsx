import { useState } from "react";
import { useApp } from "../App.js";
import { replyTo } from "../lib/api.js";

/** Inline reply form for an inbound message. Threading headers are derived
 * server-side from the original message; the client only sends the body. */
export function ReplyForm({ messageId }: { messageId: string }) {
  const { mailbox } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!mailbox || !text.trim()) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const res = await replyTo(mailbox, messageId, { text });
      if (res.accepted) {
        setResult("Reply sent.");
        setText("");
      } else {
        setError(res.error ?? "The mail provider rejected the reply.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send reply");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} style={styles.form}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Reply to this message…`}
        rows={5}
        style={styles.textarea}
      />
      <div style={styles.actions}>
        <button type="submit" disabled={sending || !text.trim()} style={styles.primary}>
          {sending ? "Sending…" : "Send reply"}
        </button>
        {result && <span style={styles.ok}>{result}</span>}
        {error && <span style={styles.error}>{error}</span>}
      </div>
    </form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  form: { marginTop: "1.5rem" },
  textarea: { width: "100%", boxSizing: "border-box", padding: "0.6rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", fontFamily: "inherit", resize: "vertical" },
  actions: { marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.75rem" },
  primary: { padding: "0.45rem 0.9rem", background: "#2563eb", color: "white", border: "none", borderRadius: "0.25rem", cursor: "pointer" },
  ok: { color: "#059669", fontSize: "0.85rem" },
  error: { color: "#dc2626", fontSize: "0.85rem" },
};