# RUNTIME-VIEW-PERF local verification and recovery

Run from the repository root with its existing dependencies and pinned local PostgreSQL image:

```sh
node packages/db/tests/runtime-view-perf/run-local.mjs --local-only
node packages/db/tests/runtime-view-perf/extra.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node packages/db/tests/v3/run-workbench.mjs --runtime-only --with-staging-schema --without-app --schema-from-files
```

The first two runners only accept a local Unix Docker socket and a random loopback port, do not read
dotenv or database URL variables, build with the canonical file builder and remove their own containers.
The full comparison intentionally runs the slow pre-fix view at all four sizes and can take several
minutes. Evidence is written under `docs/validation/runtime-view-perf/`. Times are local synthetic data,
not staging or real-model acceptance. The 100-execution test is also registered in the existing Runtime
integration suite (no new CI workflow, exclusions or relaxed assertions).

## Migration and rollback boundary

Risk high: database permission RPC implementations. **Owner approval is required separately for merge
and remote migration application.** This task performs neither. Never apply the local platform/baseline
or fixture files to an existing remote database.

After approval, use the existing database release procedure: capture the original function definitions
and catalog fingerprint in a READ ONLY transaction, execute `precheck.sql` (all five rows must be true),
apply only `0158_runtime_view_perf.sql`, verify ledger and post-application fingerprint against built.
The migration itself repeats the MD5 guards inside its transaction. Any unrecognized definition aborts
without partial changes; never expand an allowlist to force an application. It is safe to apply twice.

For recovery, `rollback.sql` restores the four original functions and removes the new internal helper.
It checks the exact old/new function identities first, rejects later drift, and does not modify execution,
history, billing or financial rows. Repeated rollback is safe. Use it only after Owner approval and after
confirming no later migration depends on the helper; its DROP has no CASCADE, so catalog-tracked dependencies fail closed. PostgreSQL does not track every
PL/pgSQL body reference; separately inspect later source changes before removing the helper.
Capture/compare fingerprints before and after recovery and record the migration-ledger state through
the existing release process rather than rewriting history. Reapplying 0158 restores the optimized state.

No new client or service-role function grant is introduced. The helper is invoker-only and called by
existing definer RPCs. Permissions are checked afresh on every statement; successful checks retain their
existing row locks. The helper walks the existing dependency graph, reuses existing direct/context
validators, and propagates denied or cross-actor dependencies backwards. No persistent authorization
cache is added. The current-execution authorization at the beginning of session_items is retained in
addition to the deduplicated selected-history checks.
