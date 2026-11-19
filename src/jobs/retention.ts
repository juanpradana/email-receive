import type Database from "better-sqlite3";
import { createMessagesRepo } from "../db/repo/messages.js";
import type { Storage } from "../services/storage.js";

const RETENTION_BATCH = 100;

/**
 * Rolls every tenant's outbound hourly counter whose hour has already passed.
 * Tenants already counted in `now`'s UTC hour are left untouched. Called from
 * the retention loop so a tenant that stops sending does not carry a stale
 * counter into the next day's first send.
 */
export function resetHourlyUsage(db: Database.Database, now: Date): number {
  const nowIso = now.toISOString();
  const hourKey = nowIso.slice(0, 13);
  const result = db
    .prepare(
      `UPDATE tenant_smtp_configs
       SET hourly_used = 0, hour_started = ?, updated_at = ?
       WHERE hour_started IS NULL OR substr(hour_started, 1, 13) < ?`,
    )
    .run(nowIso, nowIso, hourKey);
  return result.changes;
}


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