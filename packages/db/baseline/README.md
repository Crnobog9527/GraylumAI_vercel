# Empty-database baseline

Building a database from repository files only (a new environment, a local check) runs, in order:

1. what the Supabase platform provides (roles, `auth.uid()`, the `extensions` and `storage`
   schemas); locally `packages/db/tests/baseline/platform-local.sql` stands in for it;
2. `0000_core_prerequisites.sql`: default privileges and the 16 core tables that migration 0001
   and later assume but never create, in the early shape those migrations expect;
3. every file in `packages/db/migrations` in file-name order. A file in `bridges/` named exactly
   like a migration runs immediately before that migration.

Nothing here is ever applied to staging or any database that already exists. Migration 0148
converges the result to the staging structure; `node packages/db/tests/run-db-baseline-replay.mjs
--local-only` builds an empty database this way and fails on any difference from the staging
fingerprint that `packages/db/tests/baseline/expected-differences.json` does not list.

## Rules

- New structure belongs in a new migration, never in the baseline. Change the baseline only when an
  existing migration cannot run on an empty database, and say why in the PR.
- Baseline and bridge files bypass the migration ledger, so their rules are enforced in code
  (`packages/db/tests/baseline/file-rules.mjs`, used by the safeguard test and by the replay before
  anything runs): no psql meta-command lines, no dollar-quoted blocks, and the replay sends them to
  the server with `psql -c` so psql never interprets `\!`, `\i` or `\gexec` in them. Apply them the
  same way (as one server-side string) when building a real environment.
- Bridges reproduce a deletion staging went through outside the repository, where no baseline
  shape can make a later migration's fail-closed precondition pass. They may only
  `DROP ... IF EXISTS` (enforced by `scripts/tests/db-baseline-bridges.test.mjs`). **Adding a
  bridge is a review blocker** unless the PR shows that neither the baseline nor a migration can do
  it. Existing bridge: `0143_ticket_grants_and_own_rls.sql` (four 0004 ticket policies).
- When a migration changes staging's structure, the staging fingerprint and the expected
  differences are refreshed in the same PR.
