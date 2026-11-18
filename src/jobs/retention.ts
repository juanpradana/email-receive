import type Database from "better-sqlite3";
import { createMessagesRepo } from "../db/repo/messages.js";
import type { Storage } from "../services/storage.js";

const RETENTION_BATCH = 100;

export async function purgeExpired(
  db: Database.Database,
  storage: Storage,
  retentionDays: number,
  now: Date,
): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const messages = createMessagesRepo(db);
  let removed = 0;

  for (;;) {
    const expired = messages.listOlderThan(cutoff, RETENTION_BATCH);
    if (expired.length === 0) break;

    for (const message of expired) {
      const files = db
        .prepare("SELECT path FROM attachments WHERE message_id = ?")
        .all(message.id) as Array<{ path: string }>;
      const paths = [
        message.raw_path,
        ...(message.html_path ? [message.html_path] : []),
        ...files.map((file) => file.path),
      ];

      messages.deleteHard(message.id);
      for (const file of paths) {
        await storage.delete(file).catch(() => undefined);
      }
      removed += 1;
    }

    if (expired.length < RETENTION_BATCH) break;
  }

  return removed;
}