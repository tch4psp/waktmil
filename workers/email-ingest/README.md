# Cloudflare Email Ingest Worker

This Worker transports raw RFC 5322 mail from Cloudflare Email Routing to the Express ingestion endpoint. It does not parse MIME, write to PostgreSQL, store mail, forward mail, or send mail.

`EMAIL_INGEST_SECRET` is a Worker secret, not a Wrangler `vars` value. For local development, copy `.dev.vars.example` to ignored `.dev.vars`, start Express with the same synthetic secret and a reachable test database, then run `npm run worker:dev`. POST RFC 5322 data to `http://127.0.0.1:8787/cdn-cgi/handler/email?from=sender@example.test&to=<active-mailbox>@example.test` as documented by Cloudflare.

For deployment, set the non-secret `MAIL_DOMAIN`, `BACKEND_INGEST_URL`, and `EMAIL_INGEST_MAX_MESSAGE_BYTES` in Wrangler/Dashboard, then run `npm run worker:deploy` and set `EMAIL_INGEST_SECRET` with `wrangler secret put EMAIL_INGEST_SECRET`.
