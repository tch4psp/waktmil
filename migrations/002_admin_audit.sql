CREATE TABLE admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NULL REFERENCES admins(id) ON DELETE SET NULL,
  action varchar(64) NOT NULL,
  target_type varchar(64) NOT NULL,
  target_id varchar(320) NULL,
  source_ip_hash bytea NULL,
  request_id uuid NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_events_created_idx ON admin_audit_events (created_at DESC);
