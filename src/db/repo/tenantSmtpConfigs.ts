import type Database from "better-sqlite3";

export interface SmtpConfigRow {
  tenant_id: string;
  provider: string;
  api_key_ref: string | null;
  daily_limit: number;
  daily_used: number;
  day_started: string | null;
  hourly_limit: number;
  hourly_used: number;
  hour_started: string | null;
  updated_at: string;
}

export interface EnsureInput {
  hourlyLimit: number;
  dailyLimit?: number;
  now: string;
}

export interface ConsumeInput {
  hourlyLimit: number;
  dailyLimit: number;
  now: string;
}

const hourKey = (iso: string) => iso.slice(0, 13);
const dayKey = (iso: string) => iso.slice(0, 10);

export function createTenantSmtpConfigsRepo(db: Database.Database) {
  const find = (tenantId: string): SmtpConfigRow | undefined =>
    db.prepare("SELECT * FROM tenant_smtp_configs WHERE tenant_id = ?").get(tenantId) as SmtpConfigRow | undefined;

  /**
   * Creates the tenant's provider config on first use. An existing row is
   * returned untouched: limits are set once at provisioning time so a route
   * call with a different default cannot silently raise a tenant's quota.
   */
  const ensure = (tenantId: string, { hourlyLimit, dailyLimit = 1000, now }: EnsureInput): SmtpConfigRow => {
    const existing = find(tenantId);
    if (existing) return existing;

    db.prepare(
      `INSERT INTO tenant_smtp_configs
         (tenant_id, provider, api_key_ref, daily_limit, daily_used, day_started,
          hourly_limit, hourly_used, hour_started, updated_at)
       VALUES (?, 'resend', NULL, ?, 0, ?, ?, 0, ?, ?)`,
    ).run(tenantId, dailyLimit, now, hourlyLimit, now, now);

    return find(tenantId)!;
  };

  /**
   * Reserves one send from the tenant's rolling hourly and daily budgets.
   * Returns false when either budget is exhausted. Counters roll over on
   * UTC hour / UTC day boundaries.
   */
  const consume = (tenantId: string, { hourlyLimit, dailyLimit, now }: ConsumeInput): boolean => {
    const config = ensure(tenantId, { hourlyLimit, dailyLimit, now });

    // Hourly check
    const sameHour = config.hour_started !== null && hourKey(config.hour_started) === hourKey(now);
    const hourlyUsed = sameHour ? config.hourly_used : 0;
    if (hourlyUsed >= hourlyLimit) return false;

    // Daily check
    const sameDay = config.day_started !== null && dayKey(config.day_started) === dayKey(now);
    const dailyUsed = sameDay ? config.daily_used : 0;
    if (dailyUsed >= dailyLimit) return false;

    db.prepare(
      `UPDATE tenant_smtp_configs
       SET hourly_used = ?, hour_started = ?, hourly_limit = ?,
           daily_used = ?, day_started = ?, daily_limit = ?,
           updated_at = ?
       WHERE tenant_id = ?`,
    ).run(
      hourlyUsed + 1,
      sameHour ? config.hour_started : now,
      hourlyLimit,
      dailyUsed + 1,
      sameDay ? config.day_started : now,
      dailyLimit,
      now,
      tenantId,
    );

    return true;
  };

  return { ensure, consume, find };
}