# PAY-COMMON / DATA-ERASURE combined local verification

```sh
node packages/db/tests/monthly-refund/run-local.mjs --local-only --from-0186
node packages/db/tests/erasure-completion/run-local.mjs --local-only
```

The first command reuses the monthly runner and its canonical build, permissions,
concurrency and recovery cases. At migration 0186 it compares the local catalog to
`staging-0186-fingerprint.json` at its recorded precision (using only the existing
platform-only exclusions). This immutable fixture is copied byte-for-byte from
`packages/db/tests/baseline/staging-fingerprint.json` at commit
`41534c4ae7e650678bf1d4d7b3d73c6ae24c72a6` (the 0186 capture from #725).
Do not refresh it when the rolling staging snapshot advances. The test then
seeds synthetic open/closed accounts, attachment
references, financial rows, an unresolved original approval and a dispatched
Runtime call. It applies 0187–0196. The original 0187–0195 migrations remain
unchanged; 0196 changes the existing purge and ticket-guard function bodies, so
built is updated for that actual SQL change.
Original row fields, cash, approval and dispatch identities must remain intact;
the final catalog must match the current 0196 built fingerprint exactly.

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

The test manifest/classification and HTTP bodies are synthetic. The injected host is invoked only by local tests. There is no real
manifest verifier, deletion entry point, account, credential or network call. The
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
The initial integration imported those inputs byte-for-byte. The follow-up corrects
refund disclosure in AccountErasureCard and its inherited impact-copy helper, with
focused browser/unit tests. The other source imports remain unchanged. The
manifest/retention follow-up adds 0196 and its built
fingerprint; no table, queue, cron or HTTP endpoint is introduced.

Deployment remains unapproved: 0190 before upload, 0191 before progress, and
0193–0195 before monthly execution. Old-upload drain, real SDK compatibility,
authoritative manifest, host and binding proof remain separate. The upload
close-race's `Storage.remove` is a real external effect requiring explicit scope.
The follow-up corrects the outdated refund disclosure to DATA-ERASURE §2 /
MASTER_PLAN §2.1 item 51. It changes no eligibility, money, execution permissions
or service logic. Deployed-page validation and the external prerequisites above
remain outstanding; corrected copy does not authorize real account closure.

The manifest adapter reads only ids, ticket ownership and raw attachment paths,
including soft-deleted rows and administrator replies, using bounded keyset pages
and exact remaining counts. Missing pages, malformed references, missing parents,
query errors or budget exhaustion fail closed. It does not use the display helper,
which silently filters invalid references. Classification covers both tables across
all subjects. Shared paths and administrator/other-uploader paths remain pending,
and are never
removed by this adapter, even when a retained administrator reply appears exclusive
to the subject. This is the current authorized conservative boundary.

Current rows are not historical completeness proof. The adapter defaults to refusal
unless a trusted caller supplies `verifyRetainedHistory`; no real verifier or execution entry is
implemented here. The test verifier is valid only for the explicitly created local
synthetic fixture. It cannot be replaced by a client boolean, empty tables or an
elapsed-time assumption in deployment. Previously purged administrator references
cannot be reconstructed; affected real subjects stay unproven. Reference/upload
quiescence must separately cover inventory, classification and external deletion.

0196 serializes the existing purge with confirmation using profile SHARE locks and
preserves affected ticket/reply references until the existing Storage-verified
cleanup removes them. Ordinary non-erasure retention stays unchanged. It does not
increase the product retention period or preserve ticket bodies as a new purpose;
the purge clears expired title/description/reply content while keeping the original
ids/paths. Parent expiration also clears every reply body that the previous parent
delete would have cascaded to, including fresh or not separately soft-deleted
replies; their original metadata remains unchanged. A narrow trigger branch permits only this monotonic body erasure, with
all other fields identical; existing grants remain unchanged and still deny direct
client/service body writes. Refilling body or changing attachments is refused.
Synthetic tests exercise
public/service permissions, aged references upgraded from 0186, exact real SDK with
mock HTTP, cleanup order and two-connection closure/purge contention. Reapplying
0196 is safe; recovery is a forward correction preserving original references.
Do not restore the older purge while pending erasure references exist or claim that
rolling back code can recover already-purged history.

Deployment preparation must now enumerate 0187–0196, not reuse the old nine-file
manifest or 0195 built fingerprint. No remote migration or effect was executed.

The follow-up `host.ts` exports only injected single-subject composition. It reads
the service-only request with the same client used for the complete raw manifest,
checks the original subject/request pair and binds the processor inventory to it.
Missing history or quiescence proof refuses before processor work. These callbacks
are trusted test dependencies, not new evidence formats or client authorization.
Quiescence must remain true through all I/O settlement; the fixture owns all writers.
Neither a new account nor 0196 deployment proves historical completeness, since
ordinary open-account ticket purging is unchanged.

The host reuses Storage observation and the persisted Auth intent. Its per-instance
latch retains outstanding I/O after timeout and seals later operations, but is not
a cross-instance lock or a guarantee that a remote request was cancelled. Durable
error state is not overwritten: original errors retain priority in an incomplete
result, and the host does not write `account_erasure_note_error` from a stale read.
A future actual caller must define safe concurrency and persistent diagnostics;
this test-only composition does not authorize that caller or a scheduled entry.

Combined tests use actual local service-role reads/RPCs and the pinned SDK with
synthetic HTTP: anon/authenticated and wrong request are denied; absent proof
removes nothing; a lost Storage success is observed before continuing; a fresh
host/Auth adapter observes an existing deletion intent without resending.
No SQL/built, role grants, dependencies, route, cron, CLI, credentials or default SDK
construction change in this host slice.
