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