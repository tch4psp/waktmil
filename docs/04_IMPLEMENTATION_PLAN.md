# Implementation and Verification Plan

## Transport migration acceptance

The inbound implementation is complete only when the following remain true after removal of the self-hosted SMTP transport:

- `workers/email-ingest` is JavaScript-only and has an `email()` handler.
- Worker code transports raw bytes and signed envelope metadata without parsing MIME, storing content, forwarding or sending mail.
- `/internal/email-ingest` verifies HMAC, timestamp, nonce, byte count, body hash and exact active recipient before calling `ingestMessage`.
- Replay state is durable for the timestamp window and cleanup removes it after expiry.
- MailParser, sanitizer, ClamAV, attachment security, database transaction, duplicate behaviour, API, UI and expiration remain covered.
- Production Compose has no SMTP service or public port `25`.

## Automated verification

Run these commands with the local test dependencies available:

```text
docker compose -f compose.test.yaml up -d
$env:TEST_POSTGRES='1'; $env:TEST_CLAMAV='1'; $env:TEST_BROWSER='1'; npm test
npm run lint
docker compose config --quiet
npm audit --omit=dev
```

The Worker suite covers valid delivery, invalid/expired mailbox, malformed/oversized input, forged/expired/replayed authentication, duplicate delivery and concurrent handling. Existing MIME, sanitization, attachment and browser tests remain required.

## Admin control-plane verification

Verify authenticated settings updates reject unknown/out-of-range fields, create audit records and affect new mailbox creation or later delivery without altering deployment hard limits. Verify maintenance returns the public page while `/admin`, health and authenticated ingest remain reachable. Verify metadata lists omit content and secrets, password changes revoke other sessions, and domain controls do not invoke Cloudflare/DNS APIs.

## Browser gate

Use an isolated Chrome DevTools MCP session against local Express. Create a mailbox, ingest synthetic plaintext and hostile HTML through the new Worker path, verify inbox/message display, token absence from URL/DOM, no unexpected console errors, and no remote tracker request. Check mobile and desktop layouts.

## Owner-dependent gate

After deployment, configure Cloudflare Email Routing and test a real sender to an active random address. Test an unknown address, inspect Cloudflare Worker logs without exposing mail/secrets, confirm HTTPS headers, and verify Docker/firewall do not expose port `25`. A 24-hour production soak remains owner-dependent.
