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

## 4. RFC 8785 canonicalization and digest profile

The only canonicalization profile is `rfc8785-jcs/v1`: RFC 8785 JSON Canonicalization Scheme (JCS), applied after a versioned schema has accepted exactly one I-JSON value. The accepted G0 identifiers are normative:

- `sha256-jcs-canonical-receipt-excluding-receipt_digest`
- `sha256-jcs-canonical-event-excluding-event_digest`

The parser MUST accept UTF-8 bytes only, reject invalid UTF-8, invalid Unicode surrogate code points, duplicate keys, trailing data, comments, NaN, Infinity, a top-level type not allowed by the schema, and every unknown field. `null` and omission are distinct schema states. A schema MAY define an explicit extension namespace only in a later version; it cannot silently accept unknown fields.

JCS behavior is exact: property names are ordered by UTF-16 code units; JSON numbers use ECMAScript / IEEE-754 serialization; strings use JSON escaping required by RFC 8785; and array element order is preserved. JCS does **not** sort sets. If a schema has an unordered logical set, a separately versioned preprocessing rule (`set-normalization/v1`) MUST reject duplicates and construct the JCS input object before canonicalization. That preprocessing is not JCS behavior.

`canonical_bytes` are the UTF-8 bytes of the RFC 8785 serialization with no insignificant whitespace. Receipt digest input omits exactly `receipt_digest`; event digest input omits exactly `event_digest`; no other field is omitted. A source comment body hash is `SHA-256` over the decoded REST JSON `.body` UTF-8 bytes, never over CLI-rendered output. Any parse, normalization, canonical-byte, or digest mismatch is `CANONICALIZATION_INVALID` and fail closed.

### Interoperability vectors

| vector | JSON value before JCS | expected canonical UTF-8 JSON | purpose |
|---|---|---|---|
| `JCS-001` | `{"z":0,"a":1}` | `{"a":1,"z":0}` | basic property ordering |
| `JCS-002` | `{"\u20ac":1,"\r":2,"\ufb33":3,"1":4,"\ud83d\ude00":5}` | `{"\r":2,"1":4,"\ud83d\ude00":5,"\u20ac":1,"\ufb33":3}` | UTF-16-code-unit property ordering |
| `JCS-003` | `{"n":1e-7,"zero":0,"negative_zero":-0}` | `{"n":1e-7,"negative_zero":0,"zero":0}` | ECMAScript IEEE-754 number serialization |
| `JCS-004` | `{"array":[3,1,2]}` | `{"array":[3,1,2]}` | array order is preserved |
| `JCS-005` | duplicate key, invalid surrogate, trailing data, or digest mismatch | `REJECT` | fail-closed parse/digest boundary |

These are deterministic local vectors. Implementations MUST compare generated UTF-8 bytes to the expected canonical bytes before calculating a SHA-256 digest.

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

## 6. Versioned receipt and append-only event schemas

`graylum-owner-auth/v2` is a versioned Owner receipt schema. Required fields are `schema`, `receipt_id`, `receipt_digest_algorithm`, `receipt_digest`, `idempotency_key`, `repository`, `task`, `gate`, `transition`, `expected_prior_lifecycle_state`, `actor`, `provider`, `source_comment`, `exact_identity`, `policy_binding`, `contract_digest`, `issued_at`, `expires_at`, `ttl_seconds`, `single_use`, `allowed_actions`, `forbidden_actions`, and `lifecycle_status`. `revoke_nonce` and `supersedes` are required nullable fields: a null is not an omission.

```yaml
schema: graylum-owner-auth/v2
receipt_id: REQUIRED_UUID_OR_IMMUTABLE_PROVIDER_ID
receipt_digest_algorithm: sha256-jcs-canonical-receipt-excluding-receipt_digest
receipt_digest: REQUIRED_SHA256
idempotency_key: REQUIRED_SHA256
repository: { numeric_id: REQUIRED_INTEGER, full_name: REQUIRED_STRING, visibility: REQUIRED_STRING, default_branch: REQUIRED_STRING }
task: { issue_number: REQUIRED_INTEGER, issue_node_id: REQUIRED_NODE_ID, authority_epoch: REQUIRED_INTEGER, task_epoch: REQUIRED_INTEGER, expected_state_version: REQUIRED_INTEGER, resulting_state_version: REQUIRED_INTEGER, prior_event_digest: REQUIRED_SHA256 }
gate: REQUIRED_CLOSED_GATE_ENUM
transition: { from: REQUIRED_LIFECYCLE_STATE, to: REQUIRED_LIFECYCLE_STATE }
expected_prior_lifecycle_state: REQUIRED_LIFECYCLE_STATE
actor: { login: REQUIRED_STRING, numeric_id: REQUIRED_INTEGER, verified_role: REQUIRED_ROLE }
provider: { kind: github, identity: REQUIRED_PROVIDER_ID, authenticated_user_numeric_id: REQUIRED_INTEGER }
source_comment: { database_id: REQUIRED_INTEGER, node_id: REQUIRED_NODE_ID, body_sha256: REQUIRED_REST_UTF8_BODY_SHA256, created_at: REQUIRED_RFC3339, updated_at: REQUIRED_RFC3339 }
exact_identity: { base_ref: REQUIRED_REF, base_sha: REQUIRED_SHA, head_ref: REQUIRED_REF_OR_NULL, head_sha: REQUIRED_SHA_OR_NULL, pr_number: REQUIRED_INTEGER_OR_NULL, merge_sha: REQUIRED_SHA_OR_NULL, deployment_identity: REQUIRED_ID_OR_NULL }
policy_binding: REQUIRED_TAGGED_UNION
contract_digest: REQUIRED_SHA256
issued_at: REQUIRED_RFC3339
expires_at: REQUIRED_RFC3339
ttl_seconds: REQUIRED_POSITIVE_INTEGER
single_use: true
revoke_nonce: null
supersedes: null
lifecycle_status: ISSUED
allowed_actions: REQUIRED_ORDERED_ARRAY
forbidden_actions: REQUIRED_ORDERED_ARRAY
```

`graylum-owner-auth-event/v2` is append-only. Required fields are `schema`, `event_id`, `event_digest_algorithm`, `event_digest`, `receipt_id`, `event_sequence`, `event_type`, `expected_prior_lifecycle_state`, `resulting_lifecycle_state`, `repository`, `task`, `actor`, `provider`, `source_comment`, `exact_identity`, `policy_binding`, `contract_digest`, `occurred_at`, and `idempotency_key`.

```yaml
schema: graylum-owner-auth-event/v2
event_id: REQUIRED_UUID_OR_IMMUTABLE_PROVIDER_ID
event_digest_algorithm: sha256-jcs-canonical-event-excluding-event_digest
event_digest: REQUIRED_SHA256
receipt_id: REQUIRED_RECEIPT_ID
event_sequence: REQUIRED_POSITIVE_INTEGER
event_type: ISSUED|OBSERVED|VALIDATED|CONSUMED_ONCE|REJECTED|EXPIRED|REVOKED|SUPERSEDED
expected_prior_lifecycle_state: REQUIRED_LIFECYCLE_STATE
resulting_lifecycle_state: REQUIRED_LIFECYCLE_STATE
repository: REQUIRED_RECEIPT_REPOSITORY_OBJECT
task: REQUIRED_RECEIPT_TASK_OBJECT
actor: REQUIRED_ACTOR_OBJECT
provider: REQUIRED_PROVIDER_OBJECT
source_comment: REQUIRED_SOURCE_COMMENT_OBJECT
exact_identity: REQUIRED_EXACT_IDENTITY_OBJECT
policy_binding: REQUIRED_POLICY_BINDING
contract_digest: REQUIRED_SHA256
occurred_at: REQUIRED_RFC3339
idempotency_key: REQUIRED_SHA256
superseding_receipt_id: REQUIRED_RECEIPT_ID_OR_NULL
revoke_nonce: REQUIRED_NONCE_OR_NULL
```

The closed gate enum is taken from the accepted G0 live comment chain (including corrections), not invented locally: `PLAN`, `ADOPT_DEPENDENCY_CANDIDATE`, `READ_ONLY_EXECUTION`, `IMPLEMENTATION`, `REMEDIATION`, `MERGE_TO_STAGING`, `CLOSE_TASK`, `REOPEN_TASK`, `PRODUCTION_RELEASE`, `MERGE_TO_MAIN`, `ACCEPT_G2_POLICY_BINDING`, `EXECUTE_STAGING_ROLLBACK`, and `EXECUTE_PRODUCTION_ROLLBACK`. `G2_POLICY_BINDING_ACCEPTED` is an event, never an alias for the `ACCEPT_G2_POLICY_BINDING` receipt gate.

## 7. Deterministic event ordering and lifecycle reduction

The event primary key is `(repository.numeric_id, task.issue_node_id, task.authority_epoch, receipt_id, event_sequence)`. `event_sequence` starts at 1 and increases by exactly 1 for a receipt. A duplicate with identical canonical event digest is idempotent; a duplicate sequence with a different digest is `INVALID_FAIL_CLOSED`. There is no tie-break that selects a winner among conflicting same-position events.

The reducer orders by `event_sequence` only after repository, task, epoch, receipt, source-comment hash, provider, actor, contract digest, and exact CAS identity all match. Out-of-order events, gaps, replay after terminal consumption, comment edits, stale task state, stale ref/CAS, expired receipt, a revoked receipt, or a superseded receipt are rejected. A supersede event must name and hash the replacing receipt; a revoke must match its immutable `revoke_nonce`. A received event never changes a prior event or receipt.

## 8. Normative transition table

| source lifecycle state | event/gate | actor/provider | required receipt and exact identity/CAS | target state | failure state | allowed actions | forbidden actions | evidence / forward repair |
|---|---|---|---|---|---|---|---|---|
| `PROPOSED` | `ISSUED` / closed gate | verified Owner / GitHub | immutable v2 receipt, exact task/repo/epoch/CAS | `ISSUED` | `INVALID_FAIL_CLOSED` | publish one receipt | repository mutation before valid receipt | REST source identity; issue new receipt after correction |
| `ISSUED` | `OBSERVED` | trusted reducer / GitHub | same receipt, sequence 1, current TTL | `OBSERVED` | `INVALID_FAIL_CLOSED` | read and validate | implicit consumption | canonical receipt digest |
| `OBSERVED` | `VALIDATED` | trusted reducer / provider | sequence 2, exact actor/provider, task state, base/head/PR/merge/deployment fields where applicable | `VALIDATED` | `INVALID_FAIL_CLOSED` | gate-scoped action only | other gate, stale CAS, self-approval | fresh CAS snapshot and provider identity |
| `VALIDATED` | `CONSUMED_ONCE` | trusted transition handler | next sequence, single-use key, expected prior lifecycle state and resulting task version | `CONSUMED_ONCE` | `INVALID_FAIL_CLOSED` | exactly one bound action | replay, second writer, dual write | resulting exact identity and append-only event |
| `ISSUED` or `OBSERVED` | `EXPIRED`, `REVOKED`, or `SUPERSEDED` | reducer / verified Owner event | TTL, matching revoke nonce, or verified superseding receipt | terminal named state | `INVALID_FAIL_CLOSED` | deny and record | reuse or implicit reactivation | new receipt/task evidence is forward repair |
| any terminal state | duplicate, conflict, out-of-order, edit, or CAS mismatch | any | nonmatching digest/sequence/identity | unchanged terminal | `INVALID_FAIL_CLOSED` | read-only diagnosis | mutation or history rewrite | new task epoch/receipt if future repair is authorized |

## 9. Cutover and rollback boundary

The future G2 cutover MUST atomically activate the replacement policy and disable the legacy executable authority under one CAS, one `POLICY_BLOB_SHA`, one `authority_epoch`, and one acceptance event. `exactly-one-writer` and `dual_write_allowed=false` are mandatory. A G2 failure may enter `BLOCKED_ADVISORY` or deny only; rollback MUST NOT restore automatic `task.json`, `.agents`, tracker, or old recovery-protocol authority. G1A does not perform or simulate this cutover.
