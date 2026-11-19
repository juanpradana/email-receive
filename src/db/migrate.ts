import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "0001_init",
    sql: `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tenant_domains (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_keys_prefix ON api_keys(prefix);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  recipient_domain TEXT NOT NULL,
  message_id_header TEXT,
  sha256 TEXT NOT NULL,
  subject TEXT,
  from_addr TEXT,
  from_name TEXT,
  received_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  raw_path TEXT NOT NULL,
  body_text TEXT,
  html_path TEXT,
  snippet TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'failed')),
  error TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_tenant_received ON messages(tenant_id, received_at DESC, id DESC);
CREATE INDEX messages_tenant_sha ON messages(tenant_id, sha256, received_at);
CREATE INDEX messages_status ON messages(status);

CREATE TABLE message_recipients (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  address TEXT NOT NULL,
  name TEXT,
  PRIMARY KEY (message_id, kind, address)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  disposition TEXT,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL,
  path TEXT NOT NULL
);
CREATE INDEX attachments_message ON attachments(message_id, part_index);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX webhook_endpoints_tenant ON webhook_endpoints(tenant_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  response_status INTEGER,
  response_snippet TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
`,
  },
];

const OUTBOUND_SQL = `
CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT,
  text TEXT,
  message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'bounced')),
  error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS outbound_messages_tenant ON outbound_messages(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS outbound_messages_status ON outbound_messages(status);

CREATE TABLE IF NOT EXISTS outbound_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES outbound_messages(id) ON DELETE CASCADE,
  resend_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_flight', 'delivered', 'bounced', 'dead')),
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_deliveries_due ON outbound_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS tenant_smtp_configs (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'resend',
  api_key_ref TEXT,
  daily_limit INTEGER NOT NULL,
  daily_used INTEGER NOT NULL DEFAULT 0,
  day_started TEXT,
  hourly_limit INTEGER NOT NULL,
  hourly_used INTEGER NOT NULL DEFAULT 0,
  hour_started TEXT,
  updated_at TEXT NOT NULL
);
`;

export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );

  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      migration.version,
      migration.name,
      new Date().toISOString(),
    );
  });

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) {
      apply(migration);
    }
  }

  // Outbound tables are created outside the versioned loop so databases that
  // were already running before the feature shipped keep working. SQLite
  // cannot add tables with new foreign keys to existing parents without a
  // rebuild, and every consumer of this schema runs migrate() at boot.
  db.exec(OUTBOUND_SQL);
}