# Technical Architecture and API

## Architecture

The application is a JavaScript modular monolith. Cloudflare Email Routing owns Internet SMTP and routes every address on an onboarded mail domain to `workers/email-ingest`. The Worker sends raw RFC 5322 bytes over HTTPS to Express; it is not a parser, queue, database layer, or email sender.

`Sender -> Cloudflare MX -> catch-all -> Email Worker -> Nginx HTTPS -> Express /internal/email-ingest -> MailParser/ClamAV -> PostgreSQL + private attachment storage -> API/UI`

Cloudflare's current inbound Email Routing size limit is 25 MiB. The service intentionally imposes a stricter 10 MiB raw-message maximum. `EMAIL_INGEST_MAX_MESSAGE_BYTES`, Worker `EMAIL_INGEST_MAX_MESSAGE_BYTES`, Nginx `client_max_body_size`, and Express raw parsing must remain aligned at 10 MiB unless they are changed together.

## Worker contract

The Worker is `workers/email-ingest/src/index.mjs`, configured by `workers/email-ingest/wrangler.jsonc`. It receives `message.from`, `message.to`, `message.rawSize`, and `message.raw` from Cloudflare's `email()` handler. It buffers at most the configured maximum, calculates SHA-256, then sends `POST /internal/email-ingest` with `Content-Type: message/rfc822`.

The following headers are HMAC-SHA-256 authenticated with `EMAIL_INGEST_SECRET`:

```text
x-email-ingest-version: 1
x-email-ingest-timestamp: epoch seconds
x-email-ingest-nonce: 24 random bytes, base64url
x-email-ingest-recipient: normalized envelope RCPT TO
x-email-ingest-sender: normalized envelope MAIL FROM, or empty for a null sender
x-email-ingest-size: raw-byte count
x-email-ingest-sha256: lowercase SHA-256 hex digest
x-email-ingest-signature: base64url HMAC of the newline-separated fields above
```

Express accepts only signatures no older than `EMAIL_INGEST_MAX_AGE_SECONDS` and no further in the future than `EMAIL_INGEST_MAX_FUTURE_SKEW_SECONDS`. It uses a constant-time comparison, recomputes the raw hash, checks the byte count, and persists every accepted nonce in `email_ingest_replays` until expiry. A repeated nonce receives `409`; a legitimate redelivery with a new nonce is deduplicated only when mailbox, raw content hash, envelope sender and `Message-ID` match during the five-minute retry window.

`email_ingest_replays` is ephemeral operational state. Cleanup removes expired nonces; it is not a mail archive.

## Recipient and MIME processing

After authentication, Express splits the envelope recipient and calls `findActiveRecipient`. The domain must be enabled and the exact local part must identify an undeleted, unexpired mailbox. Unknown and expired addresses return the same Worker-facing unavailable outcome and never create mailboxes.

`ingestMessage` keeps the existing limits, MailParser parsing, HTML sanitization, attachment collection, ClamAV gate, private generated storage keys, transaction and message API. Raw RFC 5322 source is never stored after processing. Attachment-bearing mail fails when scanning fails; only `clean` attachments are downloadable.

## Internal ingest outcomes

| Express status | Worker handling |
| --- | --- |
| `202` | New message committed. |
| `200` or `409` | Duplicate/replay outcome; no second message is stored. |
| `422` or `413` | Worker permanently rejects the message. |
| `401` | Authentication failure; Worker fails rather than treating it as delivery. |
| `5xx` or timeout | Worker fails so the Cloudflare routing invocation is recorded as failed; investigate and retry through the sender/provider path. |

## Public API

Browser endpoints remain under `/api/v1`. `/internal/email-ingest` is not a browser API and does not use access tokens or CORS. Its only accepted body types are `message/rfc822` and `application/octet-stream`; all ordinary public JSON remains limited to 32 KiB.

`/api/v1/site` exposes only safe public site/viewer settings. `/api/v1/admin` requires the administrator session cookie plus CSRF token for mutations. The administrative API provides settings, domain, ingest-event, abuse/block, metadata, session and audit endpoints; it does not provide content-reading endpoints.

## Runtime control plane

The sole persisted runtime document is `system_config.admin_runtime_settings_v1`, validated against a fixed schema in `runtime-settings-service`. It is cached in-process for five seconds and invalidated by an admin write. The document has bounded mailbox TTL/message count, ingest size capped by `EMAIL_INGEST_MAX_MESSAGE_BYTES`, optional attachment acceptance and viewer display, public site text, maintenance mode, and bounded web/login rate limits. It is not a general key-value administration API.

Migration `005_admin_control_plane.sql` adds domain display/public-creation metadata and `email_ingest_events`. Ingest events retain only outcome, reason, mailbox/domain foreign keys, duration and timestamp; they retain neither sender content nor raw messages. The `admin_audit_events` table is the canonical audit log.

## Configuration

Backend: `EMAIL_INGEST_SECRET`, `EMAIL_INGEST_MAX_MESSAGE_BYTES`, `EMAIL_INGEST_MAX_AGE_SECONDS`, and `EMAIL_INGEST_MAX_FUTURE_SKEW_SECONDS` are read by `src/config/index.js`. Production requires a non-placeholder secret with at least 32 characters and an HTTPS `APP_BASE_URL`.

Worker: `MAIL_DOMAIN`, `BACKEND_INGEST_URL`, `EMAIL_INGEST_SECRET`, and `EMAIL_INGEST_MAX_MESSAGE_BYTES`. `EMAIL_INGEST_SECRET` is set with `wrangler secret put`, never in `wrangler.jsonc`.

## Removed transport

Haraka, its plugins/configuration, the SMTP container, SMTP TLS inputs, public TCP/25 exposure, and direct-VPS MX delivery are removed from this implementation. There is no outbound SMTP or relay code path.
