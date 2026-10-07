# PAY-COMMON / DATA-ERASURE combined local verification

```sh
node packages/db/tests/monthly-refund/run-local.mjs --local-only --from-0186
node packages/db/tests/erasure-completion/run-local.mjs --local-only
```

The first command reuses the monthly runner and its canonical build, permissions,
concurrency and recovery cases. At migration 0186 it compares the local catalog to
`staging-fingerprint.json` at its recorded precision (using only the existing
platform-only exclusions), then seeds synthetic open/closed accounts, attachment
references, financial rows, an unresolved original approval and a dispatched
Runtime call. It applies 0187–0195 without changing any migration or built file.
Original row fields, cash, approval and dispatch identities must remain intact;
the final catalog must match the existing 0195 built fingerprint exactly.

The exact 0752f863 upload handler is evaluated with synthetic framework/Auth/Storage
transports and real local SQL reads. Open upload and closed denial are checked;
an old upload creates no intent and therefore proves no real upload-drain claim.
The inherited invoice RPC must support idempotent replay and a new renewal.
Synthetic maintenance configuration and the renewal probe are transactionally
rolled back. The immutable Git source must be available in the checkout.

The actual locked Supabase SDK, Storage transport/core, Auth adapter and processor
are composed with real `service_role` SQL and a fetch implementation accepting only
`https://erasure.invalid`. Synthetic multi-page errors, shared references, budgets
and unknown Auth results block completion; a fresh adapter cannot resend a durable
Auth deletion. Original monthly cash uncertainty/conflict blocks Auth; late cash
may recover under the original identity. Progress RPCs retain the one-time
capability and return only stage/time/review state. The web browser tests separately
exercise the real UI/Provider/tRPC with synthetic HTTP/Auth; this is layered local
proof, not a real provider or complete deployed end-to-end acceptance.

The test manifest/classification and HTTP bodies are synthetic. There is no real
manifest host, deletion entry point, account, credential or network call. The
runner accepts only the local Unix Docker socket and pinned PG17 digest, rejects
CI/remote URLs, removes its container and temporary compiled files, and reports
failures without silently continuing. `--development` after `--from-0186` skips
historical repetitions only for debugging, never for final evidence.

The populated upgrade intentionally does not run an empty-fact rollback at 0195:
its original approval must make rollback fail. Exact empty-fact rollback coverage
is reused from unchanged #734 migrations and complemented by the deletion runner;
no test rollback script is authorization to undo a populated remote database.

Frozen inputs: #734 e63cbf9cf38e8f032f03caae73f845b11c02e0d5,
#737 e5526d4e335f57ffa21beb836364c3eb46fcec12, and
#740 38eee93d54776567740fe1be2cdf450bb6c9ce0d (UI delta from af52fda1).
The runtime imports are byte-identical to those inputs; this slice adds local tests
and evidence, not new runtime infrastructure.

Deployment remains unapproved: 0190 before upload, 0191 before progress, and
0193–0195 before monthly execution. Old-upload drain, real SDK compatibility,
authoritative manifest, host and binding proof remain separate. The upload
close-race's `Storage.remove` is a real external effect requiring explicit scope.
The existing “默认不退款” checkbox contradicts `docs/launch/tasks/DATA-ERASURE.md`
§2 / MASTER_PLAN §2.1 item 51. It is retained under the handoff boundary, recorded
as an activation blocker, and must be corrected by coordinated same-product-rule
work before real account closure is opened. No new refund promise is decided here.
