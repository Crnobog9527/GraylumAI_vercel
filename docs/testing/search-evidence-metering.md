# Search intent, execution evidence and metering

Bounded repair from staging `1482a9f4185358711c7d6913a196e6c5e22e23c0`
(actual merge of #405). Risk: **high** (search admission, billing evidence and
recovery). No migration, thresholds, subscription, routing architecture, new
provider or external activation is included.

## Contracts and preserved charging rules

Read-only official contract verification on 2026-09-10:

- [Gemini GenerateContent grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search)
  documents `google_search`, structured queries, web sources and suggestions.
  Its pricing section distinguishes Gemini 3 unique nonempty queries from
  Gemini 2.5/older grounded prompts. The reviewed text-model allowlist is in
  `searchEvidence.ts`; OpenAI-compatible transports and unreviewed models have
  no native search capability in this application.
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) supplies context
  for unit differences. No listed price or provider free allowance is imported
  into site configuration. Existing model prices still determine computed costs;
  these are not a claim about a provider invoice or remaining free allowance.
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
  and [credits](https://docs.tavily.com/documentation/api-credits) describe basic
  search and returned usage. The previously reviewed AgentKey wrapper/schema,
  basic/general parameters and quote limit remain unchanged. Live AgentKey
  discovery/execution was not performed. Tavily credits are never converted into
  actual AgentKey charges; that cost remains unknown when not reported.

The site search surcharge retains the existing one-unit charge for an answer
that actually searched. The number of distinct provider queries and provider
billing units are recorded separately. Changing to a surcharge per query is a
separate product decision, not silently part of this repair. Controlled Skill
search retains one fixed reserved site charge per successful explicit operation,
including zero matches. Existing free-tier and failure/refund rules remain.

Ordinary chat accepts explicitly configured zero surcharge. Controlled paid
Skill search still requires 1–999999, as specified by `research_user_charge` in
0071. The shared parser accepts numbers and canonical decimal integer strings;
missing, blank, malformed, fractional, negative and out-of-range values are not
converted to zero or a default. Admin single/bulk saves validate the same shape.
No SQL or historic setting format is rewritten.

## Runtime and recovery

- Local intent rules honor explicit prohibition before positive signals. Mixed
  search/transform requests retain search intent; quoted, fenced and labeled
  source material is excluded. This is a bounded heuristic, not general natural
  language understanding or a new paid classification call.
- The selected model, actual transport, private Skill boundary, existing switch,
  confidence and configured key are checked before search cost estimation. No
  capability means no search-related reservation, tools or verified-search claim.
- Native Gemini metering uses structured query snapshots. Repeated metadata does
  not add units; query/source fields may arrive separately. Contradictory, absent
  or malformed evidence is unknown. An explicit empty query array establishes
  zero only without contradictory search-source/suggestion evidence.
- Query evidence, safe source links, provider units and site surcharge are saved
  in the existing durable response before settlement, then in existing token
  metadata. Public recovery/history project only search fields. Suggestions use
  a scriptless, isolated iframe with CSP; source titles are escaped text.
- Ordinary conversation identity is synchronously committed to the URL before
  a saved answer renders, using Next's supported native History API. This closes
  a reproduced refresh race while asynchronous navigation was still pending;
  authenticated history lookup, active component identity and Skill routing are
  unchanged. The browser test delays the former RSC navigation and immediately
  checks the address and refreshes after sources become visible.
- An unknown execution retains original input and filtered partial output, with
  the original reservation. It never becomes an estimated settlement, automatic
  new request or blind refund. A saved response with insufficient balance for
  actual multi-query cost stays pending settlement; it remains readable and is
  settled using the original identity when the original billing path permits it.
- Skill search still sends only the explicit bounded query and reviewed public
  parameters. It retains root execution/usage evidence even with no source rows;
  private methods and conversation context are not appended.

## Reproducible local validation

Requires Node 24, pnpm and Docker. All model/MCP traffic is synthetic loopback;
SQL, GoTrue, PostgREST, Next HTTP and browser interactions are real local runs.
The existing disposable tools copy no environment credentials and deny other
application fetches. Source identity/digest and evidence paths are printed.

```sh
node packages/db/tests/v3/run-chat-reliability.mjs --search-baseline
node packages/db/tests/v3/run-chat-reliability.mjs --search
node packages/db/tests/v3/run-consumption-protection.mjs
node packages/db/tests/v3/run-consumption-protection.mjs --regression
node packages/db/tests/v3/run-chat-reliability.mjs
node packages/db/tests/v3/run-workbench.mjs --research-only
pnpm --filter web typecheck
pnpm --filter web lint
```

Baseline uses immutable starting runtime files in the disposable copy, while
retaining current test presentation helpers. Before repair, the intent table
failed 11/17; local HTTP reproduced forbidden tools, absent execution evidence,
zero executions charged as one, and unsupported transport reservations growing
from 35 to 10000 when only search prices changed. Test-only observation helpers
are not represented as starting runtime behavior.

The PR records final passed/failed/skipped runs and exact-candidate review.
Commands listed here do not themselves assert a pass. In particular, a first
recovery test incorrectly expected settlement despite insufficient balance; it
was corrected to verify durable pending settlement and later same-ID recovery.
No billing policy was changed to make that assertion pass.

## Minimum separately authorized environment acceptance

After the PR is clean and separately merged, verify an already configured test
account/model and existing search settings in non-production. No migration is
needed for this repair; dependencies #402/#404/#405 must already be available.
Do not enable a provider, change settings/keys, deploy or use paid calls merely
to run this task's local suite.

A minimum optional provider probe is one native supported Gemini request and
one existing controlled AgentKey/Tavily basic request, each with an explicit
public query and original request ID. Then refresh/recover both without a new
provider call. Record official structured metadata, actual provider usage,
original pre-deduction/settlement and displayed sources. Gemini may fan out to
multiple queries, so a per-request query/cost hard cap is not promised by this
adapter. A paid-probe approval must name the configured models/accounts and
acceptable total cost boundary before calls; no automatic retries, refunds,
configuration changes or production operations are included.
