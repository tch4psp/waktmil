# Security and Operations

## Inbound threat model

Cloudflare Email Routing is the public SMTP edge. A catch-all rule can route every local part to the Worker, but cannot create or revive a mailbox. The Worker is trusted only after Express verifies a shared-secret HMAC over the timestamp, nonce, envelope fields, byte count and body digest.

- A forged HTTP request lacks a valid HMAC and returns `401`.
- A captured request cannot be replayed after its nonce is recorded or its timestamp expires.
- A changed body, recipient, sender or size invalidates the signature.
- A valid signed request for an unknown, deleted, disabled-domain or expired mailbox stores nothing.
- No service in this repository accepts SMTP connections, sends mail, forwards mail, performs SMTP AUTH, or relays mail.

The endpoint must remain HTTPS-only in production. Its HMAC secret is redacted from application logs. Request bodies, raw mail, tokens and attachment data must never enter logs, Git, screenshots or prompts.

## Content and storage controls

The raw source is capped at 10 MiB. MailParser processes it with bounded text and HTML bodies. HTML is sanitized before storage and rendered in a sandboxed iframe; remote resources are stripped and never fetched. Attachments use generated private keys, are size/count limited, require ClamAV before acceptance, and force download with `nosniff` and `no-store` headers. Raw RFC 5322 data is not retained.

Mailbox access remains independent of the address: the 32-byte browser token is stored only as a hash and is never accepted in a URL. TTL and deletion are checked for browser reads, attachment downloads and ingestion.

## Deployment controls

Production Compose exposes only `80/tcp` and `443/tcp` through Nginx. PostgreSQL, ClamAV, Express and metrics remain on an internal Docker network. Do not publish port `25`, `465`, `587`, database, scanner or metrics ports. Configure firewall ingress for restricted SSH plus HTTPS/HTTP only.

Nginx allows 32 KiB for normal web traffic and a 10 MiB exception only at `/internal/email-ingest`. The endpoint still requires HMAC verification; path visibility is not authorization.

## Monitoring and recovery

Monitor container health, `/health/ready`, private `/metrics`, disk thresholds, cleanup freshness, PostgreSQL, ClamAV and ingestion failures. Cleanup removes expired mailbox/message/attachment content and old ingest nonces. Back up migrations and durable operator configuration only; do not routinely back up mailboxes, messages, attachment volumes, sessions or raw mail.

On secret compromise, rotate `EMAIL_INGEST_SECRET` in the Worker and backend together, then investigate failed/unauthorized ingest events. Secret rotation invalidates in-flight Worker requests and may require sender redelivery.

## Admin controls

The dashboard is a control plane, not an infrastructure console. It cannot change Worker credentials, backend secrets, DNS, Cloudflare routing, databases, scanner configuration, filesystems or external accounts. Its settings schema is bounded by the deployed hard limits and cannot disable HMAC verification, nonce replay protection, sanitization, iframe sandboxing, remote-resource blocking, attachment malware scanning or generated attachment keys.

Audit and ingest telemetry must contain only identifiers, safe action/outcome codes, timestamps and bounded metadata. The admin UI must not expose message bodies, attachments, raw mail, access tokens, password hashes, session secrets or unhashed source IP addresses. Maintenance mode must keep `/admin`, health checks and `/internal/email-ingest` alive.

## Launch gates

- `npm test`, `npm run lint`, configuration validation, migration application and `docker compose config` pass.
- Chrome DevTools MCP verifies the public inbox against synthetic mail received through the new ingestion route; no hostile remote resource loads.
- A deployed HTTPS endpoint and Cloudflare Email Routing catch-all are configured by the owner.
- Send real mail to a random active address and confirm it appears in the browser inbox.
- Send to a random nonexistent/expired address and confirm no mailbox/message is created.
- Verify neither the VPS firewall nor Docker publishes port 25.

Cloudflare's published inbound-routing limit is 25 MiB; the intentionally stricter 10 MiB application limit is the effective product limit. See Cloudflare's official Email Service limits documentation before changing it.
