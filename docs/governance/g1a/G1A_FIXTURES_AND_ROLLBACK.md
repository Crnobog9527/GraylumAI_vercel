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

## Accepted-G0 bootstrap policy-binding fixture

`G1A-FX-POLICY-BOOTSTRAP-001` is fixture-only and non-executable. Its source is
the direct-REST identity of Issue #278 bootstrap authorization comment
`5030614921`: node `IC_kwDOQ5MDHc8AAAABK9kXiQ`, UTF-8 body SHA-256
`f90255ec8d6fe7f85cdcbe779d392790f009f43720c743e03777807e2626493f`,
and `issued_at: 2026-07-21T05:52:05Z`. The current main/staging refs were
independently read as `a9f26d7dd4fa8fdaf716d90008ec12030379f368` and
`69beaf0b82717b0809f6a6f72c29fca0abe0b8d0`; their policy path is
`ABSENT_CONFIRMED`, so this fixture asserts no real policy blob and no live
activation.

```yaml
fixture_id: G1A-FX-POLICY-BOOTSTRAP-001
fixture_only: true
non_executable: true
no_live_activation: true
issued_at: 2026-07-21T05:52:05Z
expires_at: null
expiry_rule: no fixed timestamp; automatically superseded only by accepted G2 policy binding
policy_binding:
  kind: BOOTSTRAP_SENTINEL
  sentinel_id: GRAYLUM_G0_BOOTSTRAP_SENTINEL_V1
  sentinel_contract_digest: sha256:f90255ec8d6fe7f85cdcbe779d392790f009f43720c743e03777807e2626493f
  sentinel_epoch: 0
real_policy_blob_status: ABSENT_CONFIRMED
automatic_supersession:
  event: G2_POLICY_BINDING_ACCEPTED
  requires: POLICY_BLOB_SHA variant with positive accepted_policy_epoch
```

The sentinel contract digest above identifies the accepted bootstrap authority
fixture and is not a Git blob SHA. The fixture cannot claim a fake policy blob,
activate policy, or authorize G2.

## Fresh-window recovery reducer fixtures

The recovery algorithm reads every append-only Issue #282 comment by
`record_type`, not by the largest comment ID: independent audits, Owner
receipts, supersede/revoke/expiry records, and execution records. For each
receipt it derives exactly one of `VALID_UNCONSUMED`, `CONSUMED`, `SUPERSEDED`,
`REVOKED`, `EXPIRED`, or `INVALID`. An execution consumes a receipt only if it
uniquely matches its authorization comment ID, source-audit identity, old head,
resulting/current PR head, and allowed changed-file set. A prior consumed
receipt and its matching execution are accepted historical evidence; a second
consumption of the same receipt is fail-closed. A stale-head receipt never
authorizes the current head.

`G1A-FX-RECOVERY-001` reconstructs the existing history without relying on a
fixed future comment ID:

```yaml
history:
  - { receipt: 5207467262, derived_state: CONSUMED, matching_execution: 5213359408 }
  - { audit: 5213491955, conclusion: G1A_REMEDIATED_EXACT_HEAD_AUDIT_REVISION_REQUEST }
  - { receipt: 5213699227, derived_state: CONSUMED, matching_execution: 5213778004 }
  - { old_head: 25efe498d75ef2d2c031baf4fff715b55a5779b8 }
  - { audit: 5213972212, conclusion: G1A_SECOND_REMEDIATED_EXACT_HEAD_AUDIT_REVISION_REQUEST }
current_control_state: VALID_UNCONSUMED_RECEIPT_REQUIRED
```

`G1A-FX-RECOVERY-002` asserts that `5207467262` and `5213699227` are accepted
history, not a conflict. `G1A-FX-RECOVERY-003` provides two otherwise matching
execution records for one receipt and returns `INVALID`. `G1A-FX-RECOVERY-004`
uses an unconsumed receipt whose `head_sha` is not the current PR head and
returns `INVALID`. `G1A-FX-RECOVERY-005` derives `VALID_UNCONSUMED` for the
latest unexpired, unrevised receipt with no matching execution. `G1A-FX-RECOVERY-006`
finds exactly one dynamic matching execution by `record_type`, authorization ID,
source audit ID, old/new head, and two-file allowlist and returns
`AWAITING_CURRENT_EXACT_HEAD_INDEPENDENT_AUDIT`. `G1A-FX-RECOVERY-007` applies
a later revision-request audit and reopens remediation while preserving the
historical consumed records.

After this third receipt, one allowed commit/push, and its dynamically found
matching execution record, the same reducer derives
`AWAITING_CURRENT_EXACT_HEAD_INDEPENDENT_AUDIT`; it must not require this file
to predeclare the future execution-record comment ID.

`no-live-mutation: true` applies to every recovery fixture. A fixture cannot
create a branch, commit, PR, comment, policy event, or live enforcement result.

## Forward-only rollback packet

### Before G2 acceptance

Unaccepted G1A material may be abandoned or isolated by a future owner-approved repository operation. That operation is outside this file and must preserve the existing active authority. It must not rewrite history, edit existing receipts, restore any authority, or imply that G2 occurred. G1A itself does not delete or neutralize the five files.

### Future G2 partial failure

If replacement activation, legacy executable disable, policy digest, epoch, parity, CAS, or acceptance evidence is incomplete, the reducer enters `DENY` or `BLOCKED_ADVISORY`. Repair is forward-only: produce a corrected candidate with new identity and evidence. Never restore automatic `task.json`, `.agents`, tracker, Manus, or old recovery-protocol authority; never permit `dual_write_allowed=false` to become dual write.

### G1B boundary

G1B archive/delete is blocked until an independently accepted `G2_POLICY_BINDING_ACCEPTED` event, exact-head audit, and Owner acceptance exist. G1A cannot create that event or start G1B.

## Evidence ceiling

Repository blobs, direct GitHub REST identities, exact refs, local UTF-8/YAML/JSON parsing, and offline digest/TTL calculations are the maximum evidence available here. Current provider-side policy, runtime invocation, branch protection, Rulesets, deployments, database state, external writes, credentials, and secret values are `NOT_OBSERVABLE`. No design-time fixture or rollback statement raises that ceiling.
