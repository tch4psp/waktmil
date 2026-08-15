# Temporary Email

Temporary Email is a receive-only inbox service. The browser, Express application, PostgreSQL database, ClamAV attachment scan, and cleanup worker run on one VPS. Cloudflare Email Routing receives Internet SMTP; this repository does not run a public SMTP server.

## Inbound architecture

`Internet sender -> Cloudflare Email Routing catch-all -> Email Worker -> HTTPS POST /internal/email-ingest -> MailParser + ClamAV -> PostgreSQL/private storage -> Express API -> browser inbox`

The Worker transports original RFC 5322 bytes and signed envelope metadata. Express verifies the signature, timestamp, nonce, raw-body hash and exact active mailbox before parsing. A catch-all rule never creates a mailbox.

## Local workflow

Copy `.env.example` to ignored `.env`, set its `DATABASE_PORT=55432` for the test Compose mapping, start PostgreSQL and ClamAV with `docker compose -f compose.test.yaml up -d`, then run:

```text
npm run migrate
node scripts/seed-domain.js example.test cloudflare-routing.example.test
npm test
npm run lint
```

Run the local Worker with `npm run worker:dev`. Copy `workers/email-ingest/.dev.vars.example` to ignored `workers/email-ingest/.dev.vars` and start the Express app separately. Cloudflare's simulated email endpoint is `/cdn-cgi/handler/email`; see the Worker README for its exact local request format.

Production Compose publishes only HTTPS ports `80` and `443`. Database, ClamAV, Express and metrics remain private. Port `25` is not exposed, and the service has no SMTP AUTH, submission, relay, forwarding, or outbound-email path.

## Administration

`/admin` is a cookie-authenticated, CSRF-protected control plane. It manages typed runtime settings, domains, public mailbox creation, maintenance mode, blocks, sessions, audit records and mailbox/message metadata. It never displays mail bodies, raw RFC 822 source, attachment bytes, token material, secrets, Cloudflare credentials, DNS changes or infrastructure controls. Runtime settings are bounded by deployment configuration; they cannot relax signature checks, MIME sanitization, remote-resource blocking, malware scanning or storage limits.

## Source documents

- [AGENTS.md](AGENTS.md): binding engineering and security rules.
- [CODEX_GOAL.md](CODEX_GOAL.md): persistent implementation contract.
- [docs/01_PRODUCT_SPEC.md](docs/01_PRODUCT_SPEC.md): product behavior.
- [docs/02_TECHNICAL_SPEC.md](docs/02_TECHNICAL_SPEC.md): architecture, data and API contracts.
- [docs/03_SECURITY_AND_OPERATIONS.md](docs/03_SECURITY_AND_OPERATIONS.md): threat model, operations and launch gates.
- [docs/04_IMPLEMENTATION_PLAN.md](docs/04_IMPLEMENTATION_PLAN.md): verification plan.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): deployment runbook and owner setup.
