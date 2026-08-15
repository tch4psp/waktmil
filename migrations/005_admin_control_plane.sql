ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS display_name varchar(120) NULL,
  ADD COLUMN IF NOT EXISTS public_creation_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE email_ingest_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outcome varchar(24) NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'rejected', 'unauthorized', 'error')),
  reason_code varchar(64) NOT NULL,
  mailbox_id uuid NULL REFERENCES mailboxes(id) ON DELETE SET NULL,
  domain_id uuid NULL REFERENCES domains(id) ON DELETE SET NULL,
  duration_ms integer NULL CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_ingest_events_created_idx ON email_ingest_events (created_at DESC);
CREATE INDEX email_ingest_events_outcome_idx ON email_ingest_events (outcome, created_at DESC);
