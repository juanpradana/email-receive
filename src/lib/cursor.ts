export interface MessageCursor {
  receivedAt: string;
  id: string;
}

export function encodeCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify({ receivedAt: cursor.receivedAt, id: cursor.id }), "utf8").toString("base64url");
}

export function decodeCursor(value: string): MessageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid cursor");
  const { receivedAt, id } = parsed as Record<string, unknown>;
  if (typeof receivedAt !== "string" || Number.isNaN(Date.parse(receivedAt))) throw new Error("invalid cursor");
  if (typeof id !== "string" || id.length === 0) throw new Error("invalid cursor");
  return { receivedAt, id };
}