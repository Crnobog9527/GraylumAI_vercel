# LIB-1 DOCX dependency qualification

Scope: [approved LIB-1](https://github.com/Crnobog9527/GraylumAI_vercel/pull/546#issuecomment-5914009079).
Risk: **high**, new supply-chain dependencies. This PR has no application import,
OOXML-to-document mapping, upload endpoint, database change, or environment change.
The existing API package is the intended future server-side consumer. No new
service/framework or persistent authority is introduced. Reverting this PR removes
the dependencies and test evidence; no stored data needs migration.

## Exact dependency graph and licenses

| Dependency | Role | License | Production children | Node engine |
| --- | --- | --- | --- | --- |
| yauzl 3.4.0 | Direct, ZIP reader | MIT | pend ~1.2.0, locked 1.2.0 | >=12 |
| sax 1.6.1 | Direct, streaming XML parser | BlueOak-1.0.0 | None | >=11.0.0 |
| pend 1.2.0 | Transitive | MIT | None | Not specified |

Both direct versions are exact in `packages/api/package.json`. Lockfile changes
only add these three packages and API importer entries; no previous resolution is
updated. Tarball integrity is recorded in `pnpm-lock.yaml`. The original license
texts from the installed exact-version packages are in `lib-1-licenses/`.
This records license evidence, not a legal opinion; Owner approval is still needed
for this high-risk merge, including the sax BlueOak license.

None of these three installed package manifests declares a preinstall, install,
postinstall, or prepare hook. Installation used `--ignore-scripts`; no new native
binary or optional dependency is introduced. Existing workspace install policy,
CI workflows and security thresholds are unchanged.

Upstream metadata: [yauzl 3.4.0](https://registry.npmjs.org/yauzl/3.4.0),
[sax 1.6.1](https://registry.npmjs.org/sax/1.6.1),
[pend 1.2.0](https://registry.npmjs.org/pend/1.2.0).
GitHub global advisory queries for `ecosystem=npm&affects=<package>@<version>`
returned empty arrays for all three on 2026-09-30. This means no matching advisory
was returned at query time, not proof of no vulnerabilities. In particular,
[yauzl GHSA-gmq8-994r-jv83](https://github.com/advisories/GHSA-gmq8-994r-jv83)
affects 3.2.0, fixed in 3.2.1; this candidate selects 3.4.0.
The required Dependency Audit and Dependency Review must pass on the final PR head;
current run identities/results are recorded in the PR Handoff, not inferred from
this dated metadata lookup.

## Reproducible minimal security fixtures

Run under Node 24:

```sh
pnpm --filter @repo/api exec vitest run src/services/__tests__/lib1/dependencies.test.ts
```

These 20 tests are discovered by the existing API Vitest suite, hence normal CI;
no new workflow, script gate or dependency was added. All helper code stays inside
`__tests__/lib1/` and is never exported/imported by the application. The tiny ZIP
**writer** builds adversarial inputs in memory; yauzl performs all ZIP parsing and
sax all XML parsing. The child is only a dependency qualification harness, not the
LIB-2 production parser or a supported DOCX implementation.

Coverage:

- Exact versions and a positive namespaced UTF-8/XML/CRC case, ensuring the deny
  tests do not merely pass because the child cannot load its dependencies.
- High compression ratio rejected before inflation; forged uncompressed size
  rejected by the real yauzl stream; ZIP-slip relative, absolute, drive and
  backslash paths; dot-component aliases; duplicate entry, symlink and encrypted flag rejection.
- External file/URL and internal entity DTDs rejected; malformed ZIP/truncation/XML
  and corrupted CRC rejected. CRC is explicitly checked: yauzl's entry-size
  checking alone is not CRC verification.
- Real 10,000,000-byte input and text limits, declared 20,000,000-byte entry limit,
  2,000-entry count, 64-node XML depth, and oversized XML attribute rejection.
  sax's default buffer check alone did not reject a 100 KB attribute completed in
  one chunk; the fixture explicitly checks UTF-8 attribute/name lengths too.
- Child launched with empty environment, 128 MiB V8 heap limit, read permissions
  scoped to test code and the three package directories (including pnpm aliases).
  Extra file reads, writes and child spawning return `ERR_ACCESS_DENIED`; temporary
  directory stays empty and is removed. macOS may inject its encoding variable.
- CPU-bound fault injection signals readiness, then the same deadline path kills
  with SIGKILL and awaits `close`; PID is verified gone. The test shortens the
  deadline to 100 ms after readiness; ordinary fixture deadline is 15 seconds.
  Stdout/stderr have 64 KB caps. No untrusted file is extracted to disk.

Local qualification: Node **24.14.0**, pnpm **10.28.1**; the 20 tests, API typecheck,
API ESLint and repository code-size check passed. Final full-suite/build/CI evidence
is linked from the PR. The synthetic corpus is not evidence of complete Word
semantics or platform isolation.

## Node 24 / Vercel boundaries and next implementation prerequisites

Observed on Node 24.14.0: permission flags restrict filesystem/child-process
capabilities, but there is no network-denial permission flag. See
[Node 24 permissions](https://nodejs.org/docs/latest-v24.x/api/permissions.html).
The harness has no URL-fetch path; rejecting an XXE URL is **not** a proof that a
compromised dependency cannot open a socket. V8 heap is not total process RSS and
Node permissions are not an OS security sandbox.

The existing staging Vercel project was read via the official CLI: Node `24.x`,
Next.js framework, root `apps/web`, frozen pnpm install and `pnpm --filter web build`.
Build results and exact candidate are recorded in the PR. A dependency-only Next
build has no production parser import and therefore does **not** prove a child
executable/dependency is traced into a deployed function bundle. Local Vercel CLI
packaging likewise does not establish hosted function behavior.

Before DOCX can open, LIB-2 must separately prove complete OOXML semantics and
rejection of unsupported structures/macros/nested archives/external relationships,
ZIP overlap/variant handling, aggregate actual expansion boundaries and full token
limits, invalid encodings, real child trace inclusion, kill/reap behavior, RSS and
network/file access boundaries on the hosted Node 24 function. The minimum fixtures
here do not certify that full matrix. No sandbox claim, fallback to main-process
parsing, paid service or permission weakening is authorized by this PR. If hosted
resource/access constraints cannot be established, DOCX opening stays **BLOCKED**
and the concrete limitation goes to the controller.
