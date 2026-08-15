# Codex Goal Contract

## Current V1 architecture

Temporary Email is receive-only. Cloudflare Email Routing receives Internet SMTP and invokes `workers/email-ingest`; the Worker sends authenticated raw RFC 5322 mail to Express over HTTPS. Express remains the business-logic and persistence authority.

`Internet -> Cloudflare Email Routing -> Email Worker -> Express ingest -> MailParser/ClamAV -> PostgreSQL/private storage -> API -> browser`

Do not add a self-hosted SMTP receiver, SMTP AUTH, outbound mail, forwarding, relay behaviour, a queue, Redis, a new database, TypeScript, or a frontend framework without explicit Product Owner approval.

## Invariants

- Cloudflare catch-all routing never auto-creates a mailbox.
- Express independently validates enabled domain, exact local part, deletion and expiry before parsing mail.
- Worker-to-Express traffic uses `EMAIL_INGEST_SECRET`, a timestamp, single-use nonce, byte count and raw-body hash; secrets and raw mail are never logged.
- Browser mailbox tokens remain independent 32-byte secrets stored only as hashes server-side.
- Raw mail is discarded after bounded parsing. Sanitization, sandboxed display, ClamAV, generated attachment keys and TTL cleanup remain mandatory.
- Production publishes HTTPS only; no port `25`, `465`, or `587` is exposed.

## Completion evidence

Codex must run the changed unit/API/Worker/MIME/attachment/security tests, `npm run lint`, migration and Compose validation, and Chrome DevTools MCP for the browser inbox flow. Real Cloudflare/DNS/HTTPS delivery requires owner-controlled infrastructure and must be reported as pending when unavailable; it is never claimed as passed.

No commit or push occurs without an explicit owner request.
