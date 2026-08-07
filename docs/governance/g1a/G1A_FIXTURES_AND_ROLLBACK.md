# G1A Fixtures and Forward-only Rollback

```yaml
phase: G1A
material_type: NON_EXECUTABLE_DESIGN_AND_TEST_MATERIAL
live_enforcement_active: false
legacy_authority_disabled: false
replacement_policy_activated: false
g2_policy_binding_accepted: false
fixture_execution_mode: OFFLINE_DETERMINISTIC_DESIGN_ONLY
```

These fixtures are test vectors and acceptance criteria, not runnable scripts and not live mutation tests. Every fixture has the same attestation: `no-live-mutation: true`; no GitHub, Vercel, Supabase, Stripe, database, environment, branch, PR, Issue, workflow, or provider write is permitted.

## Deny fixture matrix

| fixture ID | input identity | expected decision | expected rejection reason | current design-time result | future G2 expected result |
|---|---|---|---|---|---|
| G1A-FX-001 | base SHA is not the receipt-bound `staging` SHA | DENY | `IDENTITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-002 | repository numeric ID differs from `1133708061` | DENY | `IDENTITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-003 | Issue differs from `282` | DENY | `IDENTITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-004 | phase is not `G1A` | DENY | `IDENTITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-005 | state version is not `3` | DENY | `IDENTITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-006 | prior event is not Owner acceptance `5049327209` | DENY | `IDENTITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-007 | actor is not Owner `Crnobog9527/244124342` | DENY | `ACTOR_OR_PROVIDER_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-008 | provider identity differs or is absent | DENY | `ACTOR_OR_PROVIDER_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-009 | admin/maintain/push/bypass capability without receipt | DENY | `SELF_APPROVAL_OR_BYPASS` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-010 | candidate PR head supplies its own policy | DENY | `SELF_APPROVAL_OR_BYPASS` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-011 | candidate PR head supplies its own PASS evidence | DENY | `SELF_APPROVAL_OR_BYPASS` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-012 | `.agents/**` is supplied as current authority | DENY | `LEGACY_AUTHORITY_REJECTED` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-013 | `task.json`, `progress.md`, `findings.md`, or `task_plan.md` is supplied as receipt | DENY | `LEGACY_AUTHORITY_REJECTED` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-014 | missing receipt source identity | DENY | `IDENTITY_INCOMPLETE` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-015 | source comment body has been edited | DENY | `RECEIPT_IMMUTABILITY_FAILURE` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-016 | same receipt is consumed twice | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-017 | two events claim the same lifecycle position with different digests | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-018 | event arrives before its required prior event | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-019 | consumed event is replayed after state advance | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-020 | receipt is past TTL | DENY | `RECEIPT_NOT_CURRENT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-021 | receipt has a revocation event | DENY | `RECEIPT_NOT_CURRENT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-022 | receipt has a supersede event | DENY | `RECEIPT_NOT_CURRENT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-023 | policy tagged union contains both sentinel and real policy | DENY | `POLICY_BINDING_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-024 | CAS snapshot differs from current exact refs | DENY | `CAS_OR_PARITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-025 | main/staging AGENTS or policy parity is not satisfied | DENY | `CAS_OR_PARITY_MISMATCH` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-026 | Draft PR base is not `staging` | DENY | `PRIMARY_PR_BOUNDARY_VIOLATION` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-027 | Draft PR base SHA differs from receipt-bound SHA | DENY | `PRIMARY_PR_BOUNDARY_VIOLATION` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-028 | PR is Ready for review or not Draft | DENY | `PRIMARY_PR_BOUNDARY_VIOLATION` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-029 | a second primary, auxiliary, replacement, stacked, or follow-up PR exists | DENY | `PRIMARY_PR_BOUNDARY_VIOLATION` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-030 | unknown JSON field or canonicalization version | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-031 | invalid UTF-8, invalid YAML, invalid JSON, duplicate key, or trailing data | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-032 | RFC 8785 property names are ordered by Unicode scalar value instead of UTF-16 code units | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-033 | array marked as a logical set is reordered during JCS instead of before its JCS input object exists | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | fail closed |
| G1A-FX-034 | future G2 reuses Issue `#282` or its node ID | DENY | `INVALID_G2_TASK_IDENTITY` | `DESIGN_ONLY_NO_LIVE_MUTATION` | require a dedicated G2 Issue and node ID |
| G1A-FX-035 | future G2 omits a `CUTOVER_FREEZE` receipt identity/digest/TTL | DENY | `MISSING_CUTOVER_FREEZE` | `DESIGN_ONLY_NO_LIVE_MUTATION` | require a new freeze receipt |
| G1A-FX-036 | future G2 uses G1A main/staging refs or a stale CAS snapshot | DENY | `STALE_G2_REF_OR_CAS` | `DESIGN_ONLY_NO_LIVE_MUTATION` | take a fresh G2-gate snapshot |
| G1A-FX-037 | a fixed source class or one `.agents/**` tree blob is absent from the exact inventory | DENY | `FIXED_CLASS_INVENTORY_OMISSION` | `DESIGN_ONLY_NO_LIVE_MUTATION` | rebuild from the exact staging tree |
| G1A-FX-038 | JCS vector canonical bytes or digest differs from its expected value | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | correct implementation/profile before any future gate |
| G1A-FX-039 | corrected JCS-002 canonical JSON, UTF-8 hex, or SHA-256 differs | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | recalculate exact RFC 8785 vector |
| G1A-FX-040 | receipt idempotency projection omits, adds, or changes a bound field | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | use graylum-owner-auth-idempotency-input/v1 |
| G1A-FX-041 | event idempotency projection omits, adds, or changes a bound field | DENY | `CANONICALIZATION_INVALID` | `DESIGN_ONLY_NO_LIVE_MUTATION` | use graylum-owner-auth-event-idempotency-input/v1 |
| G1A-FX-042 | a receipt receives a second terminal lifecycle event | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | retain first valid terminal event only |
| G1A-FX-043 | two different sequence-1 terminal events exist | DENY | `INVALID_FAIL_CLOSED` | `DESIGN_ONLY_NO_LIVE_MUTATION` | choose no winner and do not apply sequence 2 |
| G1A-FX-044 | OBSERVED or VALIDATED is submitted as a lifecycle event | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | record only as a decision/audit record |
| G1A-FX-045 | event omits receipt digest or gate | DENY | `IDENTITY_INCOMPLETE` | `DESIGN_ONLY_NO_LIVE_MUTATION` | bind receipt digest and closed gate |
| G1A-FX-046 | SUPERSEDED event omits superseding receipt digest | DENY | `IDENTITY_INCOMPLETE` | `DESIGN_ONLY_NO_LIVE_MUTATION` | bind replacement receipt ID and digest |
| G1A-FX-047 | event or receipt uses an unsupported gate | DENY | `MUTATION_NOT_AUTHORIZED` | `DESIGN_ONLY_NO_LIVE_MUTATION` | use accepted-G0 closed enum |
| G1A-FX-048 | task transition is used as receipt lifecycle state, or vice versa | DENY | `RECEIPT_LIFECYCLE_CONFLICT` | `DESIGN_ONLY_NO_LIVE_MUTATION` | keep transition and lifecycle fields separate |

## Fixture input contract

Each fixture records an immutable input identity: repository, Issue, phase, state version, prior event, exact refs, Owner/provider identity, requested mutation, policy-binding tag, receipt source identity/body hash, lifecycle position, and CAS snapshot. Omitted and `null` fields are intentionally distinct. The expected result is a design-time decision only; no fixture is connected to a workflow, Ruleset, branch protection, GitHub App, bot, dispatcher, runtime interceptor, provider call, SQL statement, or external platform.

## Fresh-window recovery fixture

`G1A-FX-RECOVERY-001` starts with no local tracker or conversation context. A fresh window must:

1. Read repository identity and active user identity through authenticated GitHub REST.
2. Read Issue `#282`, its full body and comments, and verify `state_version=3`, `BOUNDED_CORRECTION_2`, `ACTIVE`, the accepted G0 chain, independent PASS `5202274452`, the controlling audit `5204372790`, and the only consumable superseding authorization `5207467262`. Reject superseded malformed receipt `5204867513`, any revoke, later supersede, competing unsuperseded receipt, or prior remediation execution record.
3. Recompute exact comment body hashes from direct REST UTF-8 bodies and verify `created_at == updated_at`.
4. Read `main`, `staging`, merge base, both exact `AGENTS.md` blobs, policy-file absence, open issues/PRs, branch identity, and the five target paths at the bound staging SHA.
5. Recompute the authorization TTL offline and reject drift, expiry, duplicate implementation record, second task, second writer, or existing branch/PR.
6. Rebuild the same design-time conclusion: `READY_FOR_FRESH_CONTEXT_REMEDIATED_EXACT_HEAD_AUDIT` only after the five non-executable files and one Draft staging PR are independently verified. This is not proof of current live enforcement.

`no-live-mutation: true` applies to every step. The recovery fixture cannot create a branch, commit, PR, comment, or policy event.

`G1A-FX-RECOVERY-002` is the post-expiry or drift recovery boundary: discard the old authorization as non-consumable, begin a fresh context, re-read the live repository/Issue/PR/ref identities, obtain a new explicit receipt bound to the then-current exact head, and repeat an independent audit. It cannot reuse a former receipt, execute G2, restore legacy authority, or infer a policy activation.

## Forward-only rollback packet

### Before G2 acceptance

Unaccepted G1A material may be abandoned or isolated by a future owner-approved repository operation. That operation is outside this file and must preserve the existing active authority. It must not rewrite history, edit existing receipts, restore any authority, or imply that G2 occurred. G1A itself does not delete or neutralize the five files.

### Future G2 partial failure

If replacement activation, legacy executable disable, policy digest, epoch, parity, CAS, or acceptance evidence is incomplete, the reducer enters `DENY` or `BLOCKED_ADVISORY`. Repair is forward-only: produce a corrected candidate with new identity and evidence. Never restore automatic `task.json`, `.agents`, tracker, Manus, or old recovery-protocol authority; never permit `dual_write_allowed=false` to become dual write.

### G1B boundary

G1B archive/delete is blocked until an independently accepted `G2_POLICY_BINDING_ACCEPTED` event, exact-head audit, and Owner acceptance exist. G1A cannot create that event or start G1B.

## Evidence ceiling

Repository blobs, direct GitHub REST identities, exact refs, local UTF-8/YAML/JSON parsing, and offline digest/TTL calculations are the maximum evidence available here. Current provider-side policy, runtime invocation, branch protection, Rulesets, deployments, database state, external writes, credentials, and secret values are `NOT_OBSERVABLE`. No design-time fixture or rollback statement raises that ceiling.
