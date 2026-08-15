# Product Specification

## V1 scope

Visitors create a short-lived random mailbox and receive Internet email in a browser inbox. The address is not authorization: the visitor receives a separate bearer token once, stored only in browser session storage and as a server-side hash. Default lifetime is 60 minutes.

V1 receives only. It does not send, reply, forward, authenticate over SMTP, provide permanent accounts, create mailboxes from incoming addresses, or expose message content to the admin panel.

## Receive journey

1. A sender addresses `anything@MAIL_DOMAIN`.
2. Cloudflare Email Routing matches the active catch-all and invokes the Email Worker.
3. The Worker sends raw RFC 5322 mail to the private application contract over HTTPS with authenticated metadata.
4. Express accepts the delivery only for an enabled domain and exact active mailbox. Unknown, deleted and expired addresses do not create data.
5. MailParser processes bounded text/HTML/MIME; HTML is sanitized and attachments are scanned before persistence.
6. The browser sees committed mail on its next poll and can open plain text or sandboxed sanitized HTML.

## Failure behaviour

- Invalid Worker authentication or an expired/replayed request: no mail is stored.
- Unknown/expired mailbox or invalid MIME/policy violation: the Worker rejects the message.
- Database, disk, scanner, backend or timeout failure: the Worker reports delivery failure and Cloudflare/provider retry behaviour must be observed operationally.
- Duplicate redelivery: one message remains visible when the documented retry-deduplication conditions match.
- A 10 MiB raw source maximum applies even though Cloudflare Email Routing can receive up to 25 MiB.

## Attachments and viewer

V1 accepts at most five attachments, each at most 5 MiB decoded and 8 MiB total. Only clean, owned, unexpired files may be downloaded. Filenames are metadata; generated storage keys determine paths. The admin surface remains metadata-only.

The viewer never fetches remote email resources automatically. Sanitized HTML is rendered in a sandboxed iframe with no permissive tokens.

## Operator control plane

The admin dashboard can manage typed, bounded settings for newly created mailboxes and subsequent deliveries, site identity, domain availability, public creation, maintenance mode, abuse blocks and metadata retention actions. Existing mailbox expiry timestamps are not rewritten. Maintenance serves a public unavailable page while the admin, health checks, cleanup and authenticated Cloudflare ingestion remain available.

Admins can inspect mailbox and message metadata, but never message bodies, sanitized HTML, raw mail, attachment contents, bearer tokens or secrets. Password changes revoke other sessions; all privileged changes create a safe audit record.
