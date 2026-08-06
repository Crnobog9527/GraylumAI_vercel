# G1A RMG Reference Contract

```yaml
phase: G1A
material_type: NON_EXECUTABLE_DESIGN_AND_TEST_MATERIAL
live_enforcement_active: false
legacy_authority_disabled: false
replacement_policy_activated: false
g2_policy_binding_accepted: false
contract_status: PROPOSED
```

This is a normative, non-executable reference model for a future RMG. It is not a guard, service, workflow, GitHub App, bot, runtime interceptor, policy blob, or receipt signer. No implementation, merge, production, or G2 receipt is issued or consumed by this file.

## 1. Decision contract

The future RMG MUST deny by default and MUST guard before mutation. A decision is permitted only when all exact identities, immutable receipt fields, provider binding, policy binding, CAS pre-state, lifecycle order, expiry, and evidence requirements validate. A capability (`admin`, `maintain`, `push`, workflow token, or bypass) is not an Owner receipt and MUST NOT be treated as equivalent.

The request envelope is conceptually:

```yaml
repository:
  numeric_id: 1133708061
  full_name: Crnobog9527/GraylumAI_vercel
task:
  issue_number: 282
  phase: G1A
  state_version: 3
  issue_definition_revision: BOUNDED_CORRECTION_2
  prior_event_comment_database_id: 5049327209
refs:
  base_branch: staging
  base_exact_sha: REQUIRED_EXACT_REF
  head_branch: REQUIRED_EXACT_REF
  head_exact_sha: REQUIRED_EXACT_REF
authorization:
  owner_login: Crnobog9527
  owner_numeric_user_id: 244124342
  source_comment_database_id: REQUIRED_IMMUTABLE_COMMENT_ID
  source_comment_node_id: REQUIRED_IMMUTABLE_NODE_ID
  source_body_sha256: REQUIRED_BODY_SHA256
  created_at: REQUIRED_TIMESTAMP
  updated_at: REQUIRED_TIMESTAMP
provider:
  type: github
  identity: REQUIRED_PROVIDER_IDENTITY
requested_mutation: REQUIRED_ENUM_VALUE
policy_binding: REQUIRED_TAGGED_UNION
```

The exact `requested_mutation` must be bound to an allowlist. This G1A contract only describes `NON_EXECUTABLE_DESIGN_AND_TEST_MATERIAL_ONLY`; it does not authorize a live mutation.

## 2. Identity and policy binding

The reducer MUST bind repository numeric ID and full name, visibility/default branch when relevant, task Issue identity, phase, state version, issue-definition revision, prior event, exact base/head refs, Owner numeric identity, provider identity, requested mutation, and immutable source-comment identity/body hash. A changed field is a new context, not a value to be silently rebound.

`policy_binding` is a tagged union with exactly one of:

```yaml
kind: BOOTSTRAP_SENTINEL
sentinel: BOOTSTRAP_SENTINEL
policy_blob_sha: null
accepted_policy_epoch: null
```

or:

```yaml
kind: ACCEPTED_REAL_POLICY
sentinel: null
policy_blob_sha: POLICY_BLOB_SHA
accepted_policy_epoch: authority_epoch
acceptance_event: G2_POLICY_BINDING_ACCEPTED
```

`BOOTSTRAP_SENTINEL` is a pre-G2 identity binding and is not a real accepted policy. A real policy requires an independently accepted `G2_POLICY_BINDING_ACCEPTED` event, a non-null `POLICY_BLOB_SHA`, and a monotonic `authority_epoch`. G1A uses the sentinel only as a design-time pre-state; `live_enforcement_active: false` remains mandatory.

## 3. Immutable receipt lifecycle and reducer

Receipt source identity is `(comment_database_id, comment_node_id, author_numeric_user_id, body_sha256, created_at, updated_at)`. `created_at` MUST equal `updated_at`; an edit is a new or invalid context, never an in-place update. The lifecycle is append-only:

```text
ISSUED -> OBSERVED -> VALIDATED -> CONSUMED_ONCE
                         |-> REJECTED
                         |-> EXPIRED
                         |-> REVOKED
                         |-> SUPERSEDED
```

The deterministic reducer reads an ordered event set and a CAS snapshot. It MUST:

- accept one exact next event only when prior event, task identity, state version, epoch, and refs match;
- reject duplicate consumption, edited bodies, conflicting same-position events, out-of-order events, replay, stale state, expiry, revocation, supersede, and CAS mismatch;
- reject unknown actors, wrong Owner numeric ID, wrong provider, admin/bypass claims, self-approval, PR-head-supplied policy, and legacy-source authority;
- reject a second primary PR or any non-Draft/wrong-base/wrong-base-SHA candidate;
- write a decision record with exact requested mutation, identity fields, evidence digests, decision, and rejection code, with secrets redacted.

No reducer result is a live enforcement result in G1A.

## 4. Deterministic canonicalization

The future receipt digest and idempotency key MUST be reproducible from bytes:

1. Input is a UTF-8 byte sequence. Invalid UTF-8 is `CANONICALIZATION_INVALID` and fails closed.
2. Parse one JSON object. Top-level arrays, duplicate keys, comments, NaN/Infinity, and trailing data are rejected.
3. Required fields are exactly those in the versioned schema. Optional fields may be omitted. Unknown fields are forbidden unless the schema version explicitly defines an extension namespace. `null` is distinct from omission.
4. Object keys are sorted lexicographically by Unicode scalar value after validation. Arrays preserve semantic order unless the schema marks a field `set`; set arrays are sorted by each element's canonical bytes. No implicit deduplication occurs.
5. Strings use JSON escaping for quotation mark, reverse solidus, and control characters; Unicode is not case-folded or normalized. Non-ASCII scalar values are emitted as UTF-8, not implementation-specific escapes.
6. Numbers use a finite JSON number grammar with no leading plus, no leading zero (except zero), no negative zero, and the shortest round-trippable decimal representation defined by the schema. Integers in identity fields MUST be decimal integers; a numeric string is not an integer.
7. Emit compact JSON with no insignificant whitespace. The resulting bytes are `canonical_bytes`.
8. `receipt_digest = SHA-256(canonical_bytes(receipt_without_receipt_digest))`. The excluded field is exactly `receipt_digest`; no other field is excluded.
9. `idempotency_key = SHA-256(canonical_bytes({repository, task, phase, state_version, prior_event, exact_base_ref, exact_head_ref, requested_mutation, provider_identity, policy_binding, authorization_source_identity}))`. It is not derived from prose, PR title, branch name alone, or a secret.
10. `source_body_sha256` is SHA-256 of the exact UTF-8 body bytes returned by direct REST. A digest mismatch or parse failure fails closed.

The canonicalization version, schema version, and algorithm identifiers are required fields. Changing any ordering, numeric, string, null/omission, extension, or excluded-field rule creates a new contract version and invalidates old digests.

## 5. Validation and error semantics

| condition | deterministic result | rejection code |
|---|---|---|
| missing/unknown identity or field | deny | `IDENTITY_INCOMPLETE` |
| wrong repository/Issue/phase/state/prior event/ref | deny | `IDENTITY_MISMATCH` |
| wrong Owner/provider/admin/bypass actor | deny | `ACTOR_OR_PROVIDER_MISMATCH` |
| edited comment or body digest mismatch | deny | `RECEIPT_IMMUTABILITY_FAILURE` |
| duplicate, replay, conflict, out-of-order event | deny | `RECEIPT_LIFECYCLE_CONFLICT` |
| expired, revoked, or superseded receipt | deny | `RECEIPT_NOT_CURRENT` |
| policy tagged union invalid or epoch not accepted | deny | `POLICY_BINDING_INVALID` |
| stale CAS or branch parity mismatch | deny | `CAS_OR_PARITY_MISMATCH` |
| PR head supplies policy/evidence or self-approves | deny | `SELF_APPROVAL_OR_BYPASS` |
| legacy file, tracker, chat, or prose used as authority | deny | `LEGACY_AUTHORITY_REJECTED` |
| second primary, Ready-for-review, wrong base, or non-Draft | deny | `PRIMARY_PR_BOUNDARY_VIOLATION` |
| invalid UTF-8/JSON/canonical bytes | deny | `CANONICALIZATION_INVALID` |
| requested action outside allowlist or live G2/merge/production | deny | `MUTATION_NOT_AUTHORIZED` |

Every rejection is fail-closed and auditable without secret values. Redaction MUST preserve field presence/type and digest verification semantics while replacing secret values with a fixed marker such as `REDACTED_SECRET`; the marker is never accepted as a credential.

## 6. Cutover and rollback boundary

The future G2 cutover MUST atomically activate the replacement policy and disable the legacy executable authority under one CAS, one `POLICY_BLOB_SHA`, one `authority_epoch`, and one acceptance event. `exactly-one-writer` and `dual_write_allowed=false` are mandatory. A G2 failure may enter `BLOCKED_ADVISORY` or deny only; rollback MUST NOT restore automatic `task.json`, `.agents`, tracker, or old recovery-protocol authority. G1A does not perform or simulate this cutover.
