# Workbench persistent local preview

This runner is for isolated synthetic transport only. It does not enable staging,
production, paid models, remote databases or research. A passing ordinary CI job
is not Docker/browser acceptance and is not permission to merge.

## Two separate lifetimes

Without `--serve`, tests create disposable resources and remove their exact
containers, anonymous data volumes and network afterward. With `--serve`, an
explicit preview ID owns a named PostgreSQL volume. Application exit, crash,
Ctrl+C, restart or credential expiry never authorizes deletion of that volume.
The regular `finally` cannot run the persistent backend destroy operation.

Use repository Node 24 and pnpm 10.28.1, install the lockfile dependencies, and
make Docker Desktop plus the runner's images available. The credential-free
application copy uses the local pnpm cache. All application fetches remain
loopback-only. Do not copy a production `.env` into the preview.

## Start and keep the same preview

From the repository root, create a NEW synthetic preview once:

```sh
node packages/db/tests/v3/run-workbench.mjs --opc-only --serve --preview-id=owner422 --preview-action=start
```

Original-method acceptance additionally needs the existing local private
`V3_REAL_SKILL_INPUT` file. It is never committed here. The initial OPC suite
must produce `opc-acceptance.json` before this preview can become initialized;
without that input, source assertions may run but original-method preview setup
cannot be represented as complete. This command is NOT forensic data recovery.
Do not use it to recreate the four incident drafts from fixture content.

The terminal prints `PERSISTENT_PREVIEW_READY`, a loopback URL, and the exact
named volume. It stays in the foreground. Use Ctrl+C to stop its application and
local gateway without deleting the database. Then resume from another terminal
or a fresh clone with the same private state directory:

```sh
node packages/db/tests/v3/run-workbench.mjs --serve --preview-id=owner422 --preview-action=resume
```

`resume`, `restart` and `renew` reuse the original schema/mode flags and stable
application/gateway ports. They do NOT run SQL bootstrap, migrations, fixtures,
account creation, draft/Session creation, top-ups or initial sample curation.
They require intact owned resources and an initialized state. Missing resources,
a changed mode, a mismatched secret or foreign volume fail closed; they do not
fall back to a fresh database. A failed initial setup is retained for diagnosis.

## Credentials are not data lifetime

Role credentials last at most two hours. A warning appears ten minutes before
expiry. Ctrl+C first, then use:

```sh
node packages/db/tests/v3/run-workbench.mjs --serve --preview-id=owner422 --preview-action=renew
```

This launches a fresh application copy with new short-lived anon/service role
credentials signed by the same local secret. No business data is bootstrapped.
Reload the browser to receive its new public anon configuration. Browser user
access/refresh tokens remain GoTrue-managed and distinct from these role keys;
re-login may be required when a user session is invalid. The runner tests a
valid service credential plus expired/wrong-secret credentials against local
PostgREST before starting the application. These are runtime checks, not claims
that they have already run on a particular candidate.

Signing state is a private mode-0600 JSON file below
`~/.graylum/workbench-previews` by default. `V3_PREVIEW_STATE_ROOT` may specify a
private directory OUTSIDE the repository. Keep this directory with the preview;
do not publish it, attach it to a PR or place it in Git. A local lease prevents
concurrent lifecycle commands. It never sends a signal to a PID read from disk.
After an uncatchable runner crash, a local operator must verify the old runner
and its child process group are gone before removing that preview's exact
`owner.json` lease marker and empty `.lock` directory. Do not remove its JSON
state, evidence directory or database volume to clear a lease.

## Stop versus destroy

After Ctrl+C has ended the serving runner, stop only the owned backend containers:

```sh
node packages/db/tests/v3/run-workbench.mjs --serve --preview-id=owner422 --preview-action=stop
```

Later `resume` starts those same containers and uses the same named volume.
`restart` also means a fresh serving application after the prior runner stopped;
it is not a background process manager or hot credential rotation service.

To irreversibly remove ONLY a disposable acceptance preview, verify its data is
no longer needed and explicitly match the ID twice. For example, for a separate
throwaway preview named `lifecycle-test`:

```sh
node packages/db/tests/v3/run-workbench.mjs --serve --preview-id=lifecycle-test --preview-action=destroy --confirm-destroy=lifecycle-test
```

The implementation verifies all resource names, ownership labels, loopback
bindings, DB mount and auth/rest signing material BEFORE the first stop/remove.
Only that preview's three containers, network and named volume are removed.
Signing state is removed only after successful destruction. Read-back evidence
is retained. No prune, wildcards or forensic-volume cleanup is supported.

## Local acceptance still required

Run a separate throwaway persistent preview through normal exit, forced app
exit, stop, restart, resume and renew. Compare original actor/draft/Session IDs,
answers, information status/version/confirmation IDs, plans/items, Runtime
executions and billing records before and after. No lifecycle-only action may
create additional business identities or charges. Verify short credentials fail
closed at expiry, renewal restores access without new data, and destroy affects
only the named throwaway preview. Run a disposable test separately and verify
its exact resources are removed.

In the browser, verify one current question, provisional autosave, explicit
confirmation before the next question appears, earlier-answer revision, preserved
conversation, refresh/re-login and original-request recovery without duplicate
Runtime execution or charging.

For the incident's four original drafts, use the separately preserved full
PGDATA backup and a NEW verified working copy under local supervision. The
original evidence volume and forensic copy must not be adopted or destroyed by
this runner. The supplied draft JSON is a comparison excerpt, not a full dump
or a restore mechanism. Restore/adoption needs the actual local backup, PostgreSQL
version, auth metadata and signing/resource configuration checked first; a new
synthetic preview cannot stand in for that evidence. No original data recovery
or real browser acceptance is asserted by this document.
