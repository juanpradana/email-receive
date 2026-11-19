import { useEffect, useState } from "react";
import { useApp } from "../App.js";
import { listMessages, listOutbound } from "../lib/api.js";
import type { MessageListItem, OutboundListItem } from "../lib/types.js";

type Row =
  | ({ direction: "in" } & MessageListItem)
  | ({ direction: "out" } & OutboundListItem);

export function Inbox() {
  const { mailbox, setPage, setMessageId } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mailbox) return;
    let cancelled = false;

    async function load(m: NonNullable<typeof mailbox>) {
      try {
        setLoading(true);
        const [inbound, outbound] = await Promise.all([listMessages(m), listOutbound(m)]);
        if (cancelled) return;
        setRows([
          ...inbound.map((m) => ({ direction: "in" as const, ...m })),
          ...outbound.map((m) => ({ direction: "out" as const, ...m })),
        ]);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(mailbox);
    return () => {
      cancelled = true;
    };
  }, [mailbox]);

  const sorted = [...rows].sort((a, b) => timestamp(b) - timestamp(a));

  if (loading) return <div>Loading…</div>;
  if (error) return <div style={styles.error}>{error}</div>;

  return (
    <div>
      <h2 style={styles.heading}>Inbox ({sorted.length})</h2>
      {sorted.length === 0 ? (
        <p style={styles.empty}>
          No messages yet.{" "}
          <button onClick={() => setPage("compose")} style={styles.link}>
            Compose one
          </button>
        </p>
      ) : (
        <ul style={styles.list}>
          {sorted.map((row) => (
            <li
              key={`${row.direction}-${row.id}`}
              style={styles.item}
              onClick={() => {
                if (row.direction === "in") {
                  setMessageId(row.id);
                  setPage("read");
                }
              }}
            >
              <div style={styles.row}>
                <strong>{row.subject || "(no subject)"}</strong>
                <span style={styles.badge}>{row.direction === "in" ? "in" : "out"}</span>
              </div>
              <div style={styles.meta}>
                <span>{row.direction === "in" ? (row.envelopeFrom ?? row.fromAddr) : row.to.join(", ")}</span>
                <span>{new Date(baseTime(row)).toLocaleString()}</span>
              </div>
              <div style={styles.snippet}>
                {row.direction === "in" ? (row.snippet ?? "") : row.status === "failed" ? (row.error ?? "") : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function baseTime(row: Row): string {
  return row.direction === "in" ? row.receivedAt : row.createdAt;
}

function timestamp(row: Row): number {
  return new Date(baseTime(row)).getTime();
}

const styles: Record<string, React.CSSProperties> = {
  heading: { marginTop: 0, marginBottom: "1rem" },
  empty: { color: "#6b7280" },
  link: { background: "none", border: "none", color: "#2563eb", cursor: "pointer", textDecoration: "underline" },
  error: { color: "#dc2626", marginBottom: "1rem" },
  list: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" },
  item: { border: "1px solid #e5e7eb", borderRadius: "0.375rem", padding: "0.75rem", cursor: "pointer", background: "white" },
  row: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" },
  badge: { fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: "0.25rem", background: "#e5e7eb" },
  meta: { fontSize: "0.85rem", color: "#6b7280", display: "flex", gap: "1rem", marginBottom: "0.25rem" },
  snippet: { fontSize: "0.85rem", color: "#4b5563", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
};