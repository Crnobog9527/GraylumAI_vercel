# Core database functions: current full definitions

One file per function name (overloads share a file), grouped as:

- `billing/` — `bill2_*`, `atomic_*`
- `runtime/` — `runtime_*`
- `erasure/` — `account_erasure_*`, `content_erasure_*`

These files are **generated**, not written by hand. They are the `pg_get_functiondef` output of the
database built from repository files only (platform stand-in -> `packages/db/baseline` -> every
migration), so they show what each function really looks like after all the text-replacement
patches in the migrations have been applied. They are not copied from staging.

## CI check

The "Empty-database build from files" CI step (`run-db-baseline-replay.mjs --ci`) rebuilds the
database and fails when these files differ from the build (changed, missing, or left over for a
function that no longer exists), exactly as it does for `baseline/built-fingerprint.json`.

## A PR that changes one of these functions

Run one command and commit the result (needs Docker and the pinned PostgreSQL image):

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

It refreshes `built-fingerprint.json` and this directory together. After a merge conflict in
`packages/db/functions/`, resolve the migration conflict first, then re-run the command and commit
the regenerated files; never merge them by hand.

The group patterns live in `packages/db/tests/baseline/function-snapshots.mjs` (`GROUPS`).
