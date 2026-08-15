CREATE TABLE email_ingest_replays (
  nonce varchar(96) PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_ingest_replays_expiry_idx ON email_ingest_replays (expires_at);
