CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_name varchar(253) NOT NULL UNIQUE,
  mx_hostname varchar(253) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz NULL
);
CREATE UNIQUE INDEX domains_one_enabled_default ON domains ((is_default)) WHERE is_default AND is_enabled;

CREATE TABLE mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES domains(id),
  local_part varchar(64) NOT NULL,
  address varchar(320) NOT NULL UNIQUE,
  access_token_hash bytea NOT NULL,
  created_ip_hash bytea NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,
  CONSTRAINT mailboxes_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT mailboxes_local_part_unique UNIQUE (domain_id, local_part)
);
CREATE INDEX mailboxes_expiry_idx ON mailboxes (expires_at);
CREATE INDEX mailboxes_active_recipient_idx ON mailboxes (domain_id, local_part, expires_at) WHERE deleted_at IS NULL;

CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  envelope_from varchar(320) NULL,
  from_address varchar(320) NULL,
  from_name varchar(512) NULL,
  reply_to varchar(320) NULL,
  to_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject varchar(998) NOT NULL DEFAULT '',
  message_id_header varchar(998) NULL,
  sent_at timestamptz NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,
  text_body text NULL,
  html_sanitized text NULL,
  headers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_size_bytes integer NOT NULL,
  content_sha256 char(64) NOT NULL,
  parse_status varchar(16) NOT NULL DEFAULT 'ok' CHECK (parse_status IN ('ok', 'partial')),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0)
);
CREATE INDEX email_messages_inbox_idx ON email_messages (mailbox_id, received_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX email_messages_expiry_idx ON email_messages (expires_at);
CREATE INDEX email_messages_ownership_idx ON email_messages (mailbox_id, id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  original_filename varchar(512) NOT NULL,
  storage_key varchar(128) NOT NULL UNIQUE,
  declared_content_type varchar(255) NULL,
  detected_content_type varchar(255) NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  scan_status varchar(16) NOT NULL CHECK (scan_status IN ('clean', 'infected')),
  scan_signature varchar(512) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_expiry_idx ON attachments (expires_at);

CREATE TABLE abuse_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type varchar(64) NOT NULL,
  source_ip_hash bytea NULL,
  mailbox_id uuid NULL REFERENCES mailboxes(id) ON DELETE SET NULL,
  severity varchar(16) NOT NULL CHECK (severity IN ('info', 'warning', 'high', 'critical')),
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX abuse_events_created_idx ON abuse_events (created_at DESC);
CREATE INDEX abuse_events_source_idx ON abuse_events (source_ip_hash, created_at DESC);
CREATE INDEX abuse_events_expiry_idx ON abuse_events (expires_at);

CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(128) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NULL
);

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  session_token_hash bytea NOT NULL UNIQUE,
  csrf_secret_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  ip_hash bytea NULL,
  user_agent_hash bytea NULL
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE blocked_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope varchar(8) NOT NULL CHECK (scope IN ('web', 'smtp', 'both')),
  match_type varchar(16) NOT NULL CHECK (match_type IN ('ip_hash', 'cidr')),
  match_value varchar(128) NOT NULL,
  reason_code varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  created_by_admin_id uuid NULL REFERENCES admins(id) ON DELETE SET NULL
);
CREATE INDEX blocked_sources_match_idx ON blocked_sources (scope, match_type, match_value);
CREATE INDEX blocked_sources_expiry_idx ON blocked_sources (expires_at);

CREATE TABLE system_config (
  key varchar(128) PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
