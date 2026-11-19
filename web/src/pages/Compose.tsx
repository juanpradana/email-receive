import { useState } from "react";
import { useApp } from "../App.js";
import { sendOutbound } from "../lib/api.js";

export function Compose() {
  const { mailbox, setPage } = useApp();
  const [fromAddr, setFromAddr] = useState(mailbox?.fromAddr ?? "");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!mailbox) return;
    const recipients = splitAddresses(to);
    if (recipients.length === 0) {
      setError("Add at least one recipient.");
      return;
    }

    setSending(true);
    setError(null);
    setResult(null);
    try {
      const res = await sendOutbound(mailbox, {
        fromAddr,
        to: recipients,
        cc: splitAddresses(cc),
        subject,
        text,
      });
      if (res.accepted) {
        setResult("Message sent.");
        setSubject("");
        setText("");
        setTo("");
        setCc("");
      } else {
        setError(res.error ?? "The mail provider rejected the message.");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h2 style={styles.heading}>Compose</h2>
      <form onSubmit={submit} style={styles.form}>
        <label style={styles.label}>
          From
          <input value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} placeholder="me@example.com" style={styles.input} />
        </label>
        <label style={styles.label}>
          To
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="friend@example.com, other@example.com" style={styles.input} />
        </label>
        <label style={styles.label}>
          Cc
          <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="(optional)" style={styles.input} />
        </label>
        <label style={styles.label}>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} style={styles.input} />
        </label>
        <label style={styles.label}>
          Message
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} style={styles.textarea} />
        </label>
        <div style={styles.actions}>
          <button type="submit" disabled={sending} style={styles.primary}>
            {sending ? "Sending…" : "Send"}
          </button>
          <button type="button" onClick={() => setPage("inbox")} style={styles.secondary}>
            Cancel
          </button>
          {result && <span style={styles.ok}>{result}</span>}
          {error && <span style={styles.error}>{error}</span>}
        </div>
      </form>
    </div>
  );
}

export function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const styles: Record<string, React.CSSProperties> = {
  heading: { marginTop: 0, marginBottom: "1rem" },
  form: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  label: { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem", color: "#374151" },
  input: { padding: "0.5rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", fontFamily: "inherit" },
  textarea: { padding: "0.5rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", fontFamily: "inherit", resize: "vertical" },
  actions: { display: "flex", alignItems: "center", gap: "0.75rem" },
  primary: { padding: "0.45rem 0.9rem", background: "#2563eb", color: "white", border: "none", borderRadius: "0.25rem", cursor: "pointer" },
  secondary: { padding: "0.45rem 0.9rem", background: "white", color: "#374151", border: "1px solid #e5e7eb", borderRadius: "0.25rem", cursor: "pointer" },
  ok: { color: "#059669", fontSize: "0.85rem" },
  error: { color: "#dc2626", fontSize: "0.85rem" },
};