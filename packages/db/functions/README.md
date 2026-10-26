# Core database functions: current full definitions

One file per function name (overloads share a file), grouped as:

- `billing/` — `bill2_*`, `atomic_*`, `credit_*`
- `runtime/` — `runtime_*`
- `erasure/` — `account_erasure_*`, `content_erasure_*`
- `pay/` — `pay_*`
- `publish/` — `publish_*`
- `opc/` — `opc_*`
- `fusion/` — `fusion_*`
- `library/` — `library_*`
- `report/` — `report_*`
- `research/` — `research_*`
- `voice/` — `voice_*`
- `other/` — every other `public` function (Owner 2026-10-26: all functions are covered)

The first group whose pattern matches the name wins; a function no pattern matches goes to `other/`.
Functions that belong to an extension are left out. A new function family can get its own group by
adding its prefix to `GROUPS`.

These files are **generated**, not written by hand. They are the `pg_get_functiondef` output of the
database built from repository files only (platform stand-in -> `packages/db/baseline` -> every
migration), so they show what each function really looks like after every migration, including the
text-replacement patches of migrations up to 0397. They are not copied from staging.

From 0398 on, a migration changes a function by copying its file here, editing it whole and writing it
with `CREATE OR REPLACE`; reading a function's text and patching it (`pg_get_functiondef` / `prosrc`
with `replace`, `regexp_replace`, `overlay`, `position` …) is refused by `scripts/check-function-patches.mjs`.
See docs/ENGINEERING.md, "改已有数据库函数的写法".

## CI check

The "Empty-database build from files" CI step (`run-db-baseline-replay.mjs --ci`) rebuilds the
database and fails when these files differ from the build (changed, missing, or left over for a
function that no longer exists), exactly as it does for `baseline/built-fingerprint.json`.

## Every PR with a migration

Run one command and commit the result (needs Docker and the pinned PostgreSQL image):

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

It refreshes `built-fingerprint.json` and this directory together. After a merge conflict in
`packages/db/functions/`, resolve the migration conflict first, then re-run the command and commit
the regenerated files; never merge them by hand.

The group patterns live in `packages/db/tests/baseline/function-snapshots.mjs` (`GROUPS`).
