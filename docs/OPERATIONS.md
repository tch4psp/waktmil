# Operations Runbook

## Production inputs

Create ignored `secrets/` with owner-only permissions for `db_password`, `ip_hmac_key`, `https_fullchain.pem`, and `https_privkey.pem`. Set `.env` to `NODE_ENV=production`, a real HTTPS `APP_BASE_URL`, a non-placeholder `EMAIL_INGEST_SECRET` of at least 32 characters, and the normal database/admin configuration. Do not put secrets in Git, logs, screenshots, chat or Worker `vars`.

The same `EMAIL_INGEST_SECRET` is placed in Cloudflare as a Worker secret. It is intentionally an environment secret rather than a repository file.

Production Compose publishes only `80:80` and `443:443`. Allow restricted SSH plus HTTP/HTTPS in the VPS firewall. Do not expose port `25`, `465`, `587`, PostgreSQL, ClamAV, Express or metrics.

## Deployment

1. Run `docker compose config --quiet` and `docker compose build`.
2. Run `docker compose up -d`; `migrate` applies immutable migrations before `web` is healthy.
3. Check `docker compose ps`, `https://YOUR_APP_DOMAIN/health/ready`, and private metrics from the host/container network.
4. Deploy the Worker with `npm run worker:deploy`; this requires authenticated owner Cloudflare credentials but never needs backend database credentials.
5. Rotate the backend and Worker `EMAIL_INGEST_SECRET` together when needed.

## Cloudflare Owner Setup

1. Add the intended receive domain to Cloudflare and ensure its authoritative DNS nameservers are Cloudflare's.
2. In the Cloudflare dashboard, open **Compute > Email Service > Email Routing**, select **Onboard Domain**, choose the receive domain, and allow Cloudflare to add its required MX and TXT records. Do not point MX at the VPS.
3. In `workers/email-ingest/wrangler.jsonc`, set non-secret `MAIL_DOMAIN` to that domain, `BACKEND_INGEST_URL` to `https://YOUR_APP_DOMAIN/internal/email-ingest`, and keep `EMAIL_INGEST_MAX_MESSAGE_BYTES=10485760`.
4. Authenticate Wrangler for the owner account, run `npm run worker:deploy`, then run `wrangler secret put EMAIL_INGEST_SECRET --config workers/email-ingest/wrangler.jsonc`. Enter the same value used by backend `EMAIL_INGEST_SECRET` without recording it in source control.
5. Return to **Compute > Email Service > Email Routing > Routing Rules**, enable **Catch-all rule**, choose **Send to a Worker** as the action, select `temporary-email-ingest`, and save it as Active. Avoid overlapping rules that take precedence over the catch-all.
6. Create a mailbox in the site, send a real email to `random-address@DOMAIN`, and confirm it appears in that browser inbox. Send another message to a random nonexistent address and confirm no mailbox/message appears.
7. Check Email Routing activity and Worker logs for status-only failure evidence. Do not enable mail-content logging.

Cloudflare currently documents that Email Routing requires Cloudflare DNS, adds MX/TXT records during onboarding, and supports a catch-all action of **Send to a Worker**. Recheck the current dashboard wording before activation: [route emails](https://developers.cloudflare.com/email-service/get-started/route-emails/), [routing rules and catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/), and [Email Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

## Backup and recovery

Back up migrations and durable operator configuration only. Do not routinely back up `mailboxes`, `email_messages`, attachment volumes, sessions or raw mail. Use `node scripts/export-durable-config.js OUTPUT_PATH` and test restore outside production with `node scripts/restore-durable-config.js INPUT_PATH`.

## Monitoring

Watch `/health/ready`, private `/metrics`, container health, disk thresholds, cleanup freshness, PostgreSQL, ClamAV and Worker/ingest failures. At protective disk thresholds the app fails closed before new mail is accepted. Rotate proxy logs within 24 hours and application logs within 7 days.
