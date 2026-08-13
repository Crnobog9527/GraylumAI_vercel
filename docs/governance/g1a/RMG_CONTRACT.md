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
sentinel_id: GRAYLUM_G0_BOOTSTRAP_SENTINEL_V1
sentinel_contract_digest: sha256:REQUIRED_SHA256
sentinel_epoch: 0
```

or:

```yaml
kind: POLICY_BLOB_SHA
policy_path: docs/governance/DEVELOPMENT_POLICY.md
policy_blob_sha: REQUIRED_LOWERCASE_GIT_BLOB_SHA
policy_contract_digest: sha256:REQUIRED_SHA256
accepted_policy_epoch: REQUIRED_POSITIVE_INTEGER
```

Exactly one variant is valid. `BOOTSTRAP_SENTINEL` MUST contain exactly `kind`, `sentinel_id`, `sentinel_contract_digest`, and `sentinel_epoch`; it MUST NOT carry any policy-blob field. `POLICY_BLOB_SHA` MUST contain exactly `kind`, `policy_path`, `policy_blob_sha`, `policy_contract_digest`, and `accepted_policy_epoch`; it MUST NOT carry any sentinel field. `policy_blob_sha` is an exact lowercase Git blob SHA, not a branch SHA or a placeholder. `sentinel_id` is the fixed non-Git identity `GRAYLUM_G0_BOOTSTRAP_SENTINEL_V1` and MUST NOT resemble a Git SHA. The receipt and event idempotency projections bind the complete selected object, while `contract_digest` remains a separate top-level field.

`BOOTSTRAP_SENTINEL` is a pre-G2 identity binding and is not a real accepted policy. A real policy requires an independently accepted `G2_POLICY_BINDING_ACCEPTED` event, a `POLICY_BLOB_SHA` variant, and a positive accepted policy epoch. G1A uses the sentinel only as a design-time pre-state; `live_enforcement_active: false` remains mandatory.

## 3. Immutable receipt lifecycle and reducer

Receipt source identity is `(comment_database_id, comment_node_id, author_numeric_user_id, body_sha256, created_at, updated_at)`. `created_at` MUST equal `updated_at`; an edit is a new or invalid context, never an in-place update. After schema, digest, TTL, and CAS validation, an immutable receipt derives the state `ACTIVE`.

The receipt MUST NOT contain a mutable `lifecycle_status` field. `transition` describes the task-state transition with `from_task_state` and `to_task_state`; `expected_prior_lifecycle_state` is a separate receipt-lifecycle precondition. `graylum-owner-auth-event/v2` has only these terminal lifecycle events: `CONSUMED`, `REVOKED`, `SUPERSEDED`, and `EXPIRED`. `OBSERVED`, `VALIDATED`, and `REJECTED` are decision or audit records, never receipt lifecycle events. Each receipt has `initial_derived_state: ACTIVE`, exactly one valid terminal event sequence, and `maximum_valid_terminal_event_count: 1`. Two different sequence-1 terminal events are `INVALID_FAIL_CLOSED`: the reducer chooses no winner and does not apply sequence 2.

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
| `JCS-001` | `{"z":0,"a":1}` | `{"a":1,"z":0}`; hex `7b2261223a312c227a223a307d`; SHA-256 `b55af27c4bd5f02ebeca8f901b84d2940b22e7bea7230e4d06f275d903bfdd72` | basic property ordering |
| `JCS-002` | keys containing CR, `1`, `€`, `😀`, and `דּ` | `{"\r":2,"1":4,"€":1,"😀":5,"דּ":3}`; hex `7b225c72223a322c2231223a342c22e282ac223a312c22f09f9880223a352c22efacb3223a337d`; SHA-256 `1c4c88d76a119883456444688d5dfd45d182fbe91a093f7d9bbb3b8ee546add5` | UTF-16-code-unit property ordering |
| `JCS-003` | `{"n":1e-7,"zero":0,"negative_zero":-0}` | `{"n":1e-7,"negative_zero":0,"zero":0}`; hex `7b226e223a31652d372c226e656761746976655f7a65726f223a302c227a65726f223a307d`; SHA-256 `844bce6fe4e12f786bdd585e70daa06944bade5b9703fe36806e48b9a949280a` | ECMAScript IEEE-754 number serialization |
| `JCS-004` | `{"array":[3,1,2]}` | `{"array":[3,1,2]}`; hex `7b226172726179223a5b332c312c325d7d`; SHA-256 `ca87b10fa856375b19860e30ef2f1af289e5d0fad42df60543637111e3bd15bf` | array order is preserved |
| `JCS-005` | duplicate key, invalid surrogate, trailing data, or digest mismatch | `REJECT` | fail-closed parse/digest boundary |

These are deterministic local vectors. Non-control Unicode is emitted as the original character, never as a `\u` escape; CR is emitted as `\r`; and arrays retain their original order. Implementations MUST recalculate and compare the listed UTF-8 bytes and SHA-256 values before any commit.

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

`graylum-owner-auth/v2` is a closed versioned Owner receipt schema. Required fields are `schema`, `receipt_id`, `receipt_digest_algorithm`, `receipt_digest`, `idempotency_key`, `repository`, `task`, `gate`, `transition`, `actor`, `provider`, `source_comment`, `exact_identity`, `policy_binding`, `contract_digest`, `issued_at`, `expires_at`, `ttl_seconds`, `single_use`, `allowed_actions`, and `forbidden_actions`. Unknown fields are rejected. `revoke_nonce` and `supersedes` are required nullable fields: a null is not an omission. Receipt lifecycle is derived, never stored as `lifecycle_status`.

```yaml
schema: graylum-owner-auth/v2
receipt_id: REQUIRED_UUID_OR_IMMUTABLE_PROVIDER_ID
receipt_digest_algorithm: sha256-jcs-canonical-receipt-excluding-receipt_digest
receipt_digest: REQUIRED_SHA256
idempotency_key: REQUIRED_SHA256
repository: { numeric_id: REQUIRED_INTEGER, full_name: REQUIRED_STRING, visibility: REQUIRED_STRING, default_branch: REQUIRED_STRING }
task: { issue_number: REQUIRED_INTEGER, issue_node_id: REQUIRED_NODE_ID, authority_epoch: REQUIRED_INTEGER, task_epoch: REQUIRED_INTEGER, expected_state_version: REQUIRED_INTEGER, resulting_state_version: REQUIRED_INTEGER, prior_event_digest: REQUIRED_SHA256 }
gate: REQUIRED_CLOSED_GATE_ENUM
transition: { from_task_state: REQUIRED_TASK_STATE, to_task_state: REQUIRED_TASK_STATE }
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
allowed_actions: REQUIRED_ORDERED_ARRAY
forbidden_actions: REQUIRED_ORDERED_ARRAY
```

`graylum-owner-auth-event/v2` is a closed append-only event schema. Required fields are `schema`, `event_id`, `event_digest_algorithm`, `event_digest`, `event_idempotency_key`, `receipt`, `event_sequence`, `event_type`, `expected_prior_lifecycle_state`, `resulting_lifecycle_state`, `repository`, `task`, `actor`, `provider`, `source_comment`, `exact_identity`, `policy_binding`, `contract_digest`, `occurred_at`, `superseding_receipt`, `revoke_nonce`, and `reason_code`. Unknown fields are rejected.

```yaml
schema: graylum-owner-auth-event/v2
event_id: REQUIRED_UUID_OR_IMMUTABLE_PROVIDER_ID
event_digest_algorithm: sha256-jcs-canonical-event-excluding-event_digest
event_digest: REQUIRED_SHA256
receipt: { receipt_id: REQUIRED_RECEIPT_ID, receipt_digest: REQUIRED_SHA256, gate: REQUIRED_CLOSED_GATE_ENUM }
event_sequence: REQUIRED_POSITIVE_INTEGER
event_type: CONSUMED|REVOKED|SUPERSEDED|EXPIRED
expected_prior_lifecycle_state: ACTIVE
resulting_lifecycle_state: CONSUMED|REVOKED|SUPERSEDED|EXPIRED
repository: REQUIRED_RECEIPT_REPOSITORY_OBJECT
task: REQUIRED_RECEIPT_TASK_OBJECT
actor: REQUIRED_ACTOR_OBJECT
provider: REQUIRED_PROVIDER_OBJECT
source_comment: REQUIRED_SOURCE_COMMENT_OBJECT
exact_identity: REQUIRED_EXACT_IDENTITY_OBJECT
policy_binding: REQUIRED_POLICY_BINDING
contract_digest: REQUIRED_SHA256
occurred_at: REQUIRED_RFC3339
event_idempotency_key: REQUIRED_SHA256
superseding_receipt: { receipt_id: REQUIRED_RECEIPT_ID_OR_NULL, receipt_digest: REQUIRED_SHA256_OR_NULL }
revoke_nonce: REQUIRED_NONCE_OR_NULL
reason_code: REQUIRED_REASON_CODE
```

The closed gate enum is taken from the accepted G0 live correction chain, not invented locally: `TASK_START`, `CUTOVER_FREEZE`, `ACCEPT_G2_POLICY_BINDING`, `MERGE_TO_STAGING`, `STAGING_SMOKE`, `OPEN_RELEASE_PR`, `MERGE_TO_MAIN`, `PRODUCTION_SMOKE`, `EXECUTE_STAGING_ROLLBACK`, `EXECUTE_PRODUCTION_ROLLBACK`, and `TASK_CLOSE`. In particular, unsupported `PRODUCTION_RELEASE` is not a gate. `G2_POLICY_BINDING_ACCEPTED` is an event, never an alias for the `ACCEPT_G2_POLICY_BINDING` receipt gate.

### Idempotency projections

Both inputs are exact, closed JSON object schemas. They are not “profile-only”
hashes: the input is the complete listed projection. Unknown fields fail closed;
`null` and omission differ; arrays keep their supplied order; strings are UTF-8;
and RFC 8785 JCS produces the bytes to hash. Projection context is supplied by
the named version below, not by a projection-only JSON field.

#### Receipt input: `graylum-owner-auth-idempotency-input/v1`

| receipt schema path | projection path | disposition | null / array policy | reason |
|---|---|---|---|---|
| `schema` | — | EXCLUDED | omission only | versioned input schema selects this closed projection; no projection-only field is added |
| `receipt_id`, `receipt_digest_algorithm`, `receipt_digest`, `idempotency_key` | — | EXCLUDED | omission only | output/self-referential identity cannot decide its own idempotency |
| `repository.numeric_id`, `.full_name`, `.visibility`, `.default_branch` | same paths | INCLUDED | non-null scalars | full repository identity |
| `task.issue_number`, `.issue_node_id`, `.authority_epoch`, `.task_epoch`, `.expected_state_version`, `.resulting_state_version`, `.prior_event_digest` | same paths | INCLUDED | non-null scalars | complete task/CAS identity |
| `gate` | `gate` | INCLUDED | non-null scalar | accepted gate binding |
| `transition.from_task_state`, `.to_task_state` | same paths | INCLUDED | non-null scalars | task transition is distinct from lifecycle |
| `actor.login`, `.numeric_id`, `.verified_role` | same paths | INCLUDED | non-null scalars | exact actor identity |
| `provider.kind`, `.identity`, `.authenticated_user_numeric_id` | same paths | INCLUDED | non-null scalars | provider identity is bound, not inferred |
| `source_comment.database_id`, `.node_id`, `.body_sha256`, `.created_at`, `.updated_at` | same paths | INCLUDED | non-null scalars | REST comment identity and immutable timestamps |
| `exact_identity.base_ref`, `.base_sha`, `.head_ref`, `.head_sha`, `.pr_number`, `.merge_sha`, `.deployment_identity` | same paths | INCLUDED | nullable fields remain explicit `null` | exact identity is one-for-one with the receipt schema; no target/candidate/projection aliases exist |
| `policy_binding` | complete `policy_binding` object | INCLUDED | exactly one tagged-union variant | full binding; never `policy_binding: contract_digest` |
| `contract_digest` | `contract_digest` | INCLUDED | non-null scalar | independent contract binding |
| `issued_at`, `expires_at` | — | EXCLUDED | omission only | time of issuance/expiry is not an action-identity input; TTL is bound below |
| `ttl_seconds`, `single_use` | same paths | INCLUDED | non-null scalar | lifetime and consumption semantics |
| `revoke_nonce`, `supersedes` | same paths | INCLUDED | explicit `null` is retained | null is not omission; future revocation/supersession identity is bound |
| `allowed_actions`, `forbidden_actions` | same paths | INCLUDED | ordered arrays; no set sorting | exact authorization boundary |

The projection is the object containing exactly the `INCLUDED` paths above.

**Complete synthetic fixture (non-secret):**

```json
{"actor":{"login":"synthetic-owner","numeric_id":424242,"verified_role":"OWNER"},"allowed_actions":["READ_ONLY_DESIGN"],"contract_digest":"1111111111111111111111111111111111111111111111111111111111111111","exact_identity":{"base_ref":"staging","base_sha":"cccccccccccccccccccccccccccccccccccccccc","deployment_identity":null,"head_ref":"codex/synthetic","head_sha":"dddddddddddddddddddddddddddddddddddddddd","merge_sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","pr_number":999},"forbidden_actions":["MERGE","PRODUCTION"],"gate":"TASK_START","policy_binding":{"kind":"BOOTSTRAP_SENTINEL","sentinel_contract_digest":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","sentinel_epoch":0,"sentinel_id":"GRAYLUM_G0_BOOTSTRAP_SENTINEL_V1"},"provider":{"authenticated_user_numeric_id":424242,"identity":"github:user:424242","kind":"github"},"repository":{"default_branch":"staging","full_name":"example/graylum","numeric_id":1133708061,"visibility":"private"},"revoke_nonce":null,"single_use":true,"source_comment":{"body_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2030-01-01T00:00:00Z","database_id":900001,"node_id":"IC_SYNTHETIC_900001","updated_at":"2030-01-01T00:00:00Z"},"supersedes":null,"task":{"authority_epoch":0,"expected_state_version":3,"issue_node_id":"I_SYNTHETIC_282","issue_number":282,"prior_event_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resulting_state_version":3,"task_epoch":3},"transition":{"from_task_state":"PROPOSED","to_task_state":"AUTHORIZED"},"ttl_seconds":3600}
```

The JSON above is its RFC 8785 canonical JSON. Its UTF-8 hex is
`7b226163746f72223a7b226c6f67696e223a2273796e7468657469632d6f776e6572222c226e756d657269635f6964223a3432343234322c2276657269666965645f726f6c65223a224f574e4552227d2c22616c6c6f7765645f616374696f6e73223a5b22524541445f4f4e4c595f44455349474e225d2c22636f6e74726163745f646967657374223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c2265786163745f6964656e74697479223a7b22626173655f726566223a2273746167696e67222c22626173655f736861223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363222c226465706c6f796d656e745f6964656e74697479223a6e756c6c2c22686561645f726ეფ...`; SHA-256 `d69eacbf3e6f0b90fc3b4bebcf559ddca62071def6946a6ec11c0852edec251f`.

The preceding abbreviated line is a non-normative presentation preview. The normative complete fixture bytes are the full UTF-8 hex below; its independently recomputed SHA-256 is `d69eacbf3e6f0b90fc3b4bebcf559ddca62071def6946a6ec11c0852edec251f`.

```text
7b226163746f72223a7b226c6f67696e223a2273796e7468657469632d6f776e6572222c226e756d657269635f6964223a3432343234322c2276657269666965645f726f6c65223a224f574e4552227d2c22616c6c6f7765645f616374696f6e73223a5b22524541445f4f4e4c595f44455349474e225d2c22636f6e74726163745f646967657374223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c2265786163745f6964656e74697479223a7b22626173655f726566223a2273746167696e67222c22626173655f736861223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363222c226465706c6f796d656e745f6964656e74697479223a6e756c6c2c22686561645f726566223a22636f6465782f73796e746865746963222c22686561645f736861223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464222c226d657267655f736861223a2265656565656565656565656565656565656565656565656565656565656565656565656565656565222c2270725f6e756d626572223a3939397d2c22666f7262696464656e5f616374696f6e73223a5b224d45524745222c2250524f44554354494f4e225d2c2267617465223a225441534b5f5354415254222c22706f6c6963795f62696e64696e67223a7b226b696e64223a22424f4f5453545241505f53454e54494e454c222c2273656e74696e656c5f636f6e74726163745f646967657374223a227368613235363a66666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666222c2273656e74696e656c5f65706f6368223a302c2273656e74696e656c5f6964223a22475241594c554d5f47305f424f4f5453545241505f53454e54494e454c5f5631227d2c2270726f7669646572223a7b2261757468656e746963617465645f757365725f6e756d657269635f6964223a3432343234322c226964656e74697479223a226769746875623a757365723a343234323432222c226b696e64223a22676974687562227d2c227265706f7369746f7279223a7b2264656661756c745f6272616e6368223a2273746167696e67222c2266756c6c5f6e616d65223a226578616d706c652f677261796c756d222c226e756d657269635f6964223a313133333730383036312c227669736962696c697479223a2270726976617465227d2c227265766f6b655f6e6f6e6365223a6e756c6c2c2273696e676c655f757365223a747275652c22736f757263655f636f6d6d656e74223a7b22626f64795f736861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22637265617465645f6174223a22323033302d30312d30315430303a30303a30305a222c2264617461626173655f6964223a3930303030312c226e6f64655f6964223a2249435f53594e5448455449435f393030303031222c22757064617465645f6174223a22323033302d30312d30315430303a30303a30305a227d2c2273757065727365646573223a6e756c6c2c227461736b223a7b22617574686f726974795f65706f6368223a302c2265787065637465645f73746174655f76657273696f6e223a332c2269737375655f6e6f64655f6964223a22495f53594e5448455449435f323832222c2269737375655f6e756d626572223a3238322c227072696f725f6576656e745f646967657374223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22726573756c74696e675f73746174655f76657273696f6e223a332c227461736b5f65706f6368223a337d2c227472616e736974696f6e223a7b2266726f6d5f7461736b5f7374617465223a2250524f504f534544222c22746f5f7461736b5f7374617465223a22415554484f52495a4544227d2c2274746c5f7365636f6e6473223a333630307d
```

#### Event input: `graylum-owner-auth-event-idempotency-input/v1`

| event schema path | projection path | disposition | null / array policy | reason |
|---|---|---|---|---|
| `schema`, `event_id`, `event_digest_algorithm`, `event_digest`, `event_idempotency_key`, `occurred_at` | — | EXCLUDED | omission only | version selector or output/self-referential event identity |
| `receipt.receipt_id`, `.receipt_digest`, `.gate` | same paths | INCLUDED | non-null scalars | receipt ID, digest, and gate are all bound |
| `event_sequence`, `event_type`, `expected_prior_lifecycle_state`, `resulting_lifecycle_state` | same paths | INCLUDED | non-null scalars | ordered lifecycle transition |
| `repository`, `task`, `actor`, `provider`, `source_comment`, `exact_identity` | same complete objects | INCLUDED | preserve each receipt-input field and explicit null | complete inherited identity, including provider and comment timestamps |
| `policy_binding` | complete `policy_binding` object | INCLUDED | exactly one tagged-union variant | complete policy binding |
| `contract_digest` | `contract_digest` | INCLUDED | non-null scalar | separate contract binding |
| `superseding_receipt.receipt_id`, `.receipt_digest` | same paths | INCLUDED | explicit null retained | replacement identity is not omitted |
| `revoke_nonce`, `reason_code` | same paths | INCLUDED | explicit null retained for nonce | revoke/reason semantics |

The event projection contains exactly the `INCLUDED` paths; no event input may
be reduced to a single `profile` value.

**Complete synthetic fixture (non-secret; already RFC 8785 canonical JSON):**

```json
{"actor":{"login":"synthetic-owner","numeric_id":424242,"verified_role":"OWNER"},"contract_digest":"1111111111111111111111111111111111111111111111111111111111111111","event_sequence":1,"event_type":"CONSUMED","exact_identity":{"base_ref":"staging","base_sha":"cccccccccccccccccccccccccccccccccccccccc","deployment_identity":null,"head_ref":"codex/synthetic","head_sha":"dddddddddddddddddddddddddddddddddddddddd","merge_sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","pr_number":999},"expected_prior_lifecycle_state":"ACTIVE","policy_binding":{"kind":"BOOTSTRAP_SENTINEL","sentinel_contract_digest":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","sentinel_epoch":0,"sentinel_id":"GRAYLUM_G0_BOOTSTRAP_SENTINEL_V1"},"provider":{"authenticated_user_numeric_id":424242,"identity":"github:user:424242","kind":"github"},"reason_code":"MATCHING_EXECUTION","receipt":{"gate":"TASK_START","receipt_digest":"2222222222222222222222222222222222222222222222222222222222222222","receipt_id":"receipt-synthetic-001"},"repository":{"default_branch":"staging","full_name":"example/graylum","numeric_id":1133708061,"visibility":"private"},"resulting_lifecycle_state":"CONSUMED","revoke_nonce":null,"source_comment":{"body_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2030-01-01T00:00:00Z","database_id":900001,"node_id":"IC_SYNTHETIC_900001","updated_at":"2030-01-01T00:00:00Z"},"superseding_receipt":{"receipt_digest":null,"receipt_id":null},"task":{"authority_epoch":0,"expected_state_version":3,"issue_node_id":"I_SYNTHETIC_282","issue_number":282,"prior_event_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resulting_state_version":3,"task_epoch":3}}
```

UTF-8 hex:

```text
7b226163746f72223a7b226c6f67696e223a2273796e7468657469632d6f776e6572222c226e756d657269635f6964223a3432343234322c2276657269666965645f726f6c65223a224f574e4552227d2c22636f6e74726163745f646967657374223a2231313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131222c226576656e745f73657175656e6365223a312c226576656e745f74797065223a22434f4e53554d4544222c2265786163745f6964656e74697479223a7b22626173655f726566223a2273746167696e67222c22626173655f736861223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363222c226465706c6f796d656e745f6964656e74697479223a6e756c6c2c22686561645f726566223a22636f6465782f73796e746865746963222c22686561645f736861223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464222c226d657267655f736861223a2265656565656565656565656565656565656565656565656565656565656565656565656565656565222c2270725f6e756d626572223a3939397d2c2265787065637465645f7072696f725f6c6966656379636c655f7374617465223a22414354495645222c22706f6c6963795f62696e64696e67223a7b226b696e64223a22424f4f5453545241505f53454e54494e454c222c2273656e74696e656c5f636f6e74726163745f646967657374223a227368613235363a66666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666222c2273656e74696e656c5f65706f6368223a302c2273656e74696e656c5f6964223a22475241594c554d5f47305f424f4f5453545241505f53454e54494e454c5f5631227d2c2270726f7669646572223a7b2261757468656e746963617465645f757365725f6e756d657269635f6964223a3432343234322c226964656e74697479223a226769746875623a757365723a343234323432222c226b696e64223a22676974687562227d2c22726561736f6e5f636f6465223a224d41544348494e475f455845435554494f4e222c2272656365697074223a7b2267617465223a225441534b5f5354415254222c22726563656970745f646967657374223a2232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232222c22726563656970745f6964223a22726563656970742d73796e7468657469632d303031227d2c227265706f7369746f7279223a7b2264656661756c745f6272616e6368223a2273746167696e67222c2266756c6c5f6e616d65223a226578616d706c652f677261796c756d222c226e756d657269635f6964223a313133333730383036312c227669736962696c697479223a2270726976617465227d2c22726573756c74696e675f6c6966656379636c655f7374617465223a22434f4e53554d4544222c227265766f6b655f6e6f6e6365223a6e756c6c2c22736f757263655f636f6d6d656e74223a7b22626f64795f736861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22637265617465645f6174223a22323033302d30312d30315430303a30303a30305a222c2264617461626173655f6964223a3930303030312c226e6f64655f6964223a2249435f53594e5448455449435f393030303031222c22757064617465645f6174223a22323033302d30312d30315430303a30303a30305a227d2c227375706572736564696e675f72656365697074223a7b22726563656970745f646967657374223a6e756c6c2c22726563656970745f6964223a6e756c6c7d2c227461736b223a7b22617574686f726974795f65706f6368223a302c2265787065637465645f73746174655f76657273696f6e223a332c2269737375655f6e6f64655f6964223a22495f53594e5448455449435f323832222c2269737375655f6e756d626572223a3238322c227072696f725f6576656e745f646967657374223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22726573756c74696e675f73746174655f76657273696f6e223a332c227461736b5f65706f6368223a337d7d
```

SHA-256: `beb1aea9da62c3c1460f4bf34bb8e7a79b65c9467aed9fd44fdf9fdf9afcb6f9`.

## 7. Deterministic event ordering and lifecycle reduction

The event primary key is `(repository.numeric_id, task.issue_node_id, task.authority_epoch, receipt.receipt_id, event_sequence)`. The only valid terminal sequence is 1. A duplicate with identical canonical event digest is idempotent; a duplicate sequence with a different digest is `INVALID_FAIL_CLOSED`. There is no tie-break that selects a winner among conflicting same-position events, and sequence 2 is never applied.

The reducer considers a terminal event only after repository, task, epoch, receipt ID and digest, gate, source-comment hash, provider, actor, contract digest, and exact CAS identity all match. Out-of-order events, a second terminal event, replay after terminal consumption, comment edits, stale task state, stale ref/CAS, expired receipt, a revoked receipt, or a superseded receipt are rejected. A supersede event must name and hash the replacing receipt; a revoke must match its immutable `revoke_nonce`. An event never changes a prior event or receipt.

## 8. Normative transition table

| source lifecycle state | event/gate | actor/provider | required receipt and exact identity/CAS | target state | failure state | allowed actions | forbidden actions | evidence / forward repair |
|---|---|---|---|---|---|---|---|---|
| receipt publication | no lifecycle event | verified Owner / GitHub | immutable v2 receipt, exact task/repo/epoch/CAS, validated schema/digest/TTL/CAS | `ACTIVE` (derived) | `INVALID_FAIL_CLOSED` | publish one receipt | repository mutation before validation | REST source identity; issue new receipt after correction |
| `ACTIVE` | `CONSUMED` | trusted transition handler | sequence 1, single-use key, receipt digest/gate and task transition bound | `CONSUMED` | `INVALID_FAIL_CLOSED` | exactly one bound action | replay, second writer, dual write | resulting exact identity and append-only event |
| `ACTIVE` | `REVOKED` | verified Owner event | sequence 1 and matching immutable revoke nonce | `REVOKED` | `INVALID_FAIL_CLOSED` | deny and record | reuse or implicit reactivation | new receipt/task evidence is forward repair |
| `ACTIVE` | `SUPERSEDED` | verified Owner event | sequence 1 and replacing receipt ID plus digest | `SUPERSEDED` | `INVALID_FAIL_CLOSED` | deny and record | reuse or implicit reactivation | new receipt/task evidence is forward repair |
| `ACTIVE` | `EXPIRED` | reducer | sequence 1 and TTL expiry | `EXPIRED` | `INVALID_FAIL_CLOSED` | deny and record | reuse or implicit reactivation | new receipt/task evidence is forward repair |
| any terminal state | duplicate, conflict, out-of-order, edit, or CAS mismatch | any | nonmatching digest/sequence/identity | unchanged terminal | `INVALID_FAIL_CLOSED` | read-only diagnosis | mutation or history rewrite | new task epoch/receipt if future repair is authorized |

## 9. Cutover and rollback boundary

The future G2 cutover MUST atomically activate the replacement policy and disable the legacy executable authority under one CAS, one `POLICY_BLOB_SHA`, one `authority_epoch`, and one acceptance event. `exactly-one-writer` and `dual_write_allowed=false` are mandatory. A G2 failure may enter `BLOCKED_ADVISORY` or deny only; rollback MUST NOT restore automatic `task.json`, `.agents`, tracker, or old recovery-protocol authority. G1A does not perform or simulate this cutover.
