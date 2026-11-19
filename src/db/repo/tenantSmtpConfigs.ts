import type Database from "better-sqlite3";

export interface SmtpConfigRow {
  tenant_id: string;
  provider: string;
  api_key_ref: string | null;
  daily_limit: number;
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
  now: string;
}

const hourKey = (iso: string) => iso.slice(0, 13);

export function createTenantSmtpConfigsRepo(db: Database.Database) {
  const find = (tenantId: string): SmtpConfigRow | undefined =>
    db.prepare("SELECT * FROM tenant_smtp_configs WHERE tenant_id = ?").get(tenantId) as SmtpConfigRow | undefined;

  /**
   * Creates the tenant's provider config on first use. An existing row is
   * returned untouched: limits are set once at provisioning time so a route
   * call with a different default cannot silently raise a tenant's quota.
   * The rolling hour counter is not rolled here — `consume` does that.
   */
  const ensure = (tenantId: string, { hourlyLimit, dailyLimit = 1000, now }: EnsureInput): SmtpConfigRow => {
    const existing = find(tenantId);
    if (existing) return existing;

    db.prepare(
      `INSERT INTO tenant_smtp_configs
         (tenant_id, provider, api_key_ref, daily_limit, hourly_limit, hourly_used, hour_started, updated_at)
       VALUES (?, 'resend', NULL, ?, ?, 0, ?, ?)`,
    ).run(tenantId, dailyLimit, hourlyLimit, now, now);

    return find(tenantId)!;
  };

  /**
   * Reserves one send from the tenant's rolling hourly budget. Returns false
   * when the budget is exhausted; the counter rolls over on the UTC hour.
   */
  const consume = (tenantId: string, { hourlyLimit, now }: ConsumeInput): boolean => {
    const config = ensure(tenantId, { hourlyLimit, now });
    const sameHour = config.hour_started !== null && hourKey(config.hour_started) === hourKey(now);
    const used = sameHour ? config.hourly_used : 0;
    if (used >= hourlyLimit) return false;

    db.prepare(
      `UPDATE tenant_smtp_configs
       SET hourly_used = ?, hour_started = ?, hourly_limit = ?, updated_at = ?
       WHERE tenant_id = ?`,
    ).run(used + 1, sameHour ? config.hour_started : now, hourlyLimit, now, tenantId);

    return true;
  };

  return { ensure, consume, find };
}