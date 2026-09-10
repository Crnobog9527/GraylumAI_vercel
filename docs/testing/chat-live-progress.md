# Ordinary chat live progress and delivery

Bounded repair from staging `ce9b98f2ad2ecd0ee3c334e0abae0993ecc1053b`.
Risk: high (output security and the boundary between delivery and accounting).
No migration, remote permission/configuration change, new provider, price change,
or real-provider test is included.

## Behavior and boundaries

- Ordinary free chat displays checked incremental prefixes while the provider is
  still generating. The server retains at least 128 characters and a complete
  token boundary; checks are throttled to 64 new characters. Assignment openers,
  blocked or sanitized output suspend previews until full-output filtering.
  ASCII punctuation never splits an email, key or JWT. Module/Skill output is
  buffered for complete checking, with live status feedback throughout. Short
  answers or text without safe boundaries can still appear only at completion.
- Intermediate `content` events carry only newly checked text with `delta: true`;
  the client appends it only for the current request. The final full filtered
  event replaces the preview. Legacy cumulative events without the delta marker
  remain readable by the updated client. 8/16/32 KiB tests measure serialized SSE
  bytes, including framing, through the actual local HTTP route.
- Authorized history renders independently of new-request registration or status
  availability. Known earlier message IDs (no stored answer text) and server
  timestamps only identify possible display overlap. When overlap is unresolved,
  durable rows take precedence over provisional bubbles until final IDs arrive.
  Legacy browser entries without those hints keep their history visible and the
  original input accessible under “查看保留输入”. No body-text deduplication,
  client-time authorization, automatic redispatch or new accounting semantics.
- Provisional text never establishes completion, search execution or cost. The
  final filtered text replaces the preview; original authenticated durable state
  remains authoritative. No raw reasoning/tool arguments are sent to the page.
- Preparation, waiting/thinking, search processing, answering, confirmation and
  recovery have distinct labels, an indeterminate activity bar and elapsed time.
  Search permission is explicitly distinct from execution. No percentage, query
  text or query counter is invented. Verified final sources/counts use the
  existing structured evidence and original result identity.
- Healthy streams do not poll recovery. Disconnected requests use quiet single
  request polling with backoff (2/4/8/15 seconds), at most 12 automatic attempts;
  authentication/permission denial stops automatic polling. Stopping stream
  waiting preserves the existing quiet confirmation of late results.
  Exhaustion explicitly pauses the activity indicator; manual recovery remains available. Recovery retains the existing billing
  semantics: a saved `responded` result may settle, never regenerate.
- Context snapshot maintenance errors after successful finalization are logged
  separately and cannot send a provider failure or suppress the completed answer.
  This does not repair the existing remote snapshot ACL: search-digest and
  compression-checkpoint maintenance may remain unavailable there. The answer,
  search evidence and accounting remain in the existing durable request result.
  No client grants are expanded to hide this limitation.

## Verification

Existing disposable PostgreSQL/Auth/PostgREST/Next/browser runner, no live keys:

```
node packages/db/tests/v3/run-chat-reliability.mjs --live-progress-baseline
node packages/db/tests/v3/run-chat-reliability.mjs --live-progress
node packages/db/tests/v3/run-chat-reliability.mjs --delivery-regression
node packages/db/tests/v3/run-chat-reliability.mjs --openrouter
node packages/db/tests/v3/run-chat-reliability.mjs
```

Baseline uses the immutable staging runtime with current regression tests. It
reproduces two failures: missing completion after auxiliary snapshot failure and
no live browser feedback. Initial repaired run: both passed. The full suite also
checks delayed OpenRouter-shaped SSE using `qwen/qwen3.8-27b`, a provider barrier,
actual text before release, search status, quiet recovery across mid-generation
refresh, final sources, same-ID accounting and dispatch counts. Permission
failure is exercised against a real isolated table with denied client writes.

Security unit tests split email, spaced card number, API key, JWT and assignment
values across individual incoming characters. Private-method output cannot be
previewed. Existing route/filter/provider tests are rerun alongside the wire-volume test.
The 93d9ae5 pre-remediation candidate reproduced four missing-history browser
cases and quadratic SSE growth (531391 / 2111366 / 8417042 bytes in the serialized
8/16/32 KiB regression). Browser coverage includes both history/status arrival
orders, pre-claim 503 then 404, init loss with status 503, legacy stored entries,
explicit original-ID delivery and recovery, final text correction and accounting.
Final candidate validation and independent review are recorded on the PR.

This demonstrates simulated provider behavior through real local SQL/HTTP/UI;
not a claim about live OpenRouter latency or a successful paid product acceptance.
The existing $2 test credential was confirmed by the Owner. Any real acceptance
still needs a concrete bounded cost authorization; no automatic paid retries,
pending-settlement recovery, remote config changes or production operations.
