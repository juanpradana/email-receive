import type Database from "better-sqlite3";
import type { MailProvider } from "../services/mail/provider.js";
import { createOutboundRepo } from "../db/repo/outbound.js";
import { createOutboundDeliveriesRepo } from "../db/repo/outbound.js";

const BACKOFF_SECONDS = [10, 60, 300, 1800, 7200];
const MAX_ATTEMPTS = 5;

/**
 * Index into BACKOFF_SECONDS based on the attempt number. Attempt 1 (the
 * first failure) uses the 10-second slot; attempt 2 uses 60 seconds; and so
 * on. The formula clamps to the last slot for attempts beyond MAX_ATTEMPTS.
 */
function nextAttemptAt(attempts: number, now: Date): Date {
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_SECONDS.length - 1));
  const base = BACKOFF_SECONDS[index]!;
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.1)));
  return new Date(now.getTime() + (base + jitter) * 1000);
}

export async function deliverOutboundPending(
  db: Database.Database,
  provider: MailProvider,
  limit: number,
  now: Date,
): Promise<number> {
  const outbound = createOutboundRepo(db);
  const deliveries = createOutboundDeliveriesRepo(db);

  const due = deliveries.findDue(now.toISOString(), limit);
  let delivered = 0;

  for (const delivery of due) {
    // Atomically claim this delivery so concurrent dispatcher ticks cannot
    // double-send it. If the claim fails, another worker already got it.
    if (!deliveries.claimForAttempt(delivery.id, now.toISOString())) {
      continue;
    }

    const message = outbound.findGlobal(delivery.message_id);
    if (!message || message.deleted_at) {
      deliveries.markDead(delivery.id, delivery.attempts + 1, "message not found or deleted", now.toISOString());
      continue;
    }

    const result = await provider.send({
      fromAddr: message.from_addr,
      to: JSON.parse(message.to_json),
      cc: JSON.parse(message.cc_json),
      bcc: JSON.parse(message.bcc_json),
      subject: message.subject,
      html: message.html ?? undefined,
      text: message.text ?? undefined,
    });

    if (result.accepted) {
      const deliveredAt = new Date().toISOString();
      outbound.markSent(message.id, result.resendMessageId ?? "", deliveredAt);
      deliveries.markDelivered(delivery.id, result.resendMessageId ?? "", deliveredAt);
      delivered += 1;
    } else {
      const nextAttempts = delivery.attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS || result.terminal) {
        // Terminal error OR exhausted retries: mark dead
        outbound.markFailed(message.id, result.error ?? "send_failed");
        deliveries.markDead(delivery.id, nextAttempts, result.error ?? "send_failed", now.toISOString());
      } else {
        // Transient failure with retries remaining: schedule backoff
        outbound.markFailed(message.id, result.error ?? "send_failed");
        const nextAt = nextAttemptAt(nextAttempts, now);
        deliveries.markAttempt(
          delivery.id,
          nextAttempts,
          result.error ?? "send_failed",
          nextAt.toISOString(),
          now.toISOString(),
        );
      }
    }
  }

  return delivered;
}