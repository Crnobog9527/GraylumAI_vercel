# Search intent, execution evidence and metering

Bounded repair from staging `1482a9f4185358711c7d6913a196e6c5e22e23c0`
(actual merge of #405). Risk: **high** (search admission, billing evidence and
recovery). No migration, thresholds, subscription, routing architecture, new
provider or external activation is included.

## Contracts and preserved charging rules

Read-only official contract verification on 2026-09-10:

- **Primary acceptance: OpenRouter Chat Completions**, exact HTTPS endpoint
  `https://openrouter.ai/api/v1/chat/completions`. Provider labels and Gemini
  model names do not establish Google-direct transport. Current staging safe
  configuration reads identify `anthropic/claude-opus-4.5`, primary
  `qwen/qwen3.8-27b` and assistant `openai/gpt-5.6-luna`, all with the existing
  empty-endpoint OpenRouter default. Existing trusted-endpoint metadata derives
  `provider_usage`, including stale stored unsupported flags; no remote records
  were changed. Public model catalog reads list all three with tool support.
- [OpenRouter server-side web search](https://openrouter.ai/docs/guides/features/server-tools/web-search)
  uses `tools:[{type:"openrouter:web_search"}]` and can perform zero or multiple
  searches. Engine is omitted, preserving the documented default auto choice;
  no engine or search supplier is selected by this repair. The old web plugin
  is explicitly disabled to avoid an additional legacy search. `max_tool_calls:3`
  is a server tool step budget, **not** a cross-provider query or dollar hard cap.
  Native search can ignore tool limits; pending calls and final generation also
  mean cost stop conditions are not hard spending caps.
- [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
  and the [official OpenAPI snapshot](https://github.com/OpenRouterTeam/docs/blob/2bed5a83566bc1c177d834ee5438207189488b60/openapi/openapi.yaml)
  distinguish performed search counters, tool calls and total cost. Documentation
  uses `usage.server_tool_use.web_search_requests`; the schema uses nullable
  `server_tool_use_details.web_search_requests`. Both are accepted, matching
  snapshots deduplicate, conflicting/regressing counters are unknown. Missing
  or null is unreported, never an inferred zero for a search-enabled request.
  `usage.cost` and available upstream inference/server tool costs are retained
  separately. No subtraction or `server_tool_cost` is labeled actual search cost.
  Query strings are not reported by this contract and remain null.
- [OpenRouter citations](https://openrouter.ai/docs/guides/features/plugins/web-search#parsing-web-search-results)
  are structured `url_citation` annotations, not answer links or model claims.
  The adapter accepts message/delta annotations, binds stream response identity,
  and requires final metering plus `[DONE]`. A complete real server-tool SSE
  annotation capture remains part of separately authorized acceptance.
- [Gemini GenerateContent grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search)
  documents `google_search`, structured queries, web sources and suggestions.
  Its pricing section distinguishes Gemini 3 unique nonempty queries from
  Gemini 2.5/older grounded prompts. The reviewed text-model allowlist is in
  `searchEvidence.ts`. This is preserved secondary compatibility, not the Owner's
  primary model path or a prerequisite for product acceptance. Other compatible
  endpoints do not inherit OpenRouter or Gemini capabilities.
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
that actually searched. The number of performed queries and provider
billing units are recorded separately. Changing to a surcharge per query is a
separate product decision, not silently part of this repair. Controlled Skill
search retains one fixed reserved site charge per successful explicit operation,
including zero matches. Existing free-tier and failure/refund rules remain.

Configured token/search unit prices still drive the existing site cost formula;
OpenRouter's reported account total is evidence, never added again. Current
staging configured search unit cost is USD 7/1000 and surcharge is 15 credits.
These are not silently replaced by the public catalog's different native search
prices. Exact provider search-cost breakdown remains unknown when unreported.

## Account plugin configuration verification

[Plugin precedence](https://openrouter.ai/docs/guides/features/plugins) documents
that request `plugins:[{id:"web",enabled:false}]` disables an overridable account
default, while an account **Prevent overrides** lock can defeat it. No official
public API for effective plugin/lock state was found. Initial read-only account
UI access failed; the Owner subsequently opened the actual settings in Tabbit.
On 2026-09-10 the writer read the Default Workspace Web Search configuration,
closed without saving, reloaded the page and reopened Configure. The saved
**Prevent overrides was off**. Engine was Auto (native if supported, otherwise
Exa), Search Mode was Auto (displayed USD 7/1000 requests), and Max Results and
Search Prompt retained Default placeholders. No settings were changed, no Save
was pressed, and no credentials were read or printed.

The tests explicitly model a default-on but request-overridable legacy plugin.
They do not establish prevention under a forced account lock. The direct UI
verification closes the previously blocked inspection for the observed
workspace; temporary broad request blocking is not needed for this setting.
It does not establish future settings or other workspaces, or replace real
provider acceptance. Recheck the intended workspace before separately approved
real calls. No configuration activation, paid call or merge was authorized by
this read-only verification. The UI's legacy-plugin price is not proof of the
actual server-tool invoice for every native model.

[Preset tool union](https://openrouter.ai/docs/guides/features/presets) cannot be
cleared by `tools:[]`. Opaque preset/`:online` model aliases, intrinsic search
models and router aliases are rejected before ordinary-chat reservation instead
of silently switching models. Private Skill generation retains its reviewed
fixed model list, no server search tool, `tool_choice:none` and explicit disabled
legacy web plugin. The independent AgentKey/Tavily query path is unchanged.

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
node packages/db/tests/v3/run-chat-reliability.mjs --openrouter-baseline
node packages/db/tests/v3/run-chat-reliability.mjs --openrouter
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

OpenRouter baseline reuses immutable pre-correction head `70636732e505d8075f3287066522c13783f2312b`
runtime files: four prohibited requests lacked the actual plugin disable, and
the mixed search/transform request lacked the server tool. The first baseline
also had one invalid custom-endpoint fixture setup failure, excluded from defect
evidence and corrected to assert the existing token-admission rejection. Its
zero case passing did not prove search capability. Parser baseline failed all
21 OpenRouter cases before repair. The positive HTTP suite covers actual staging
model shapes, 0/1/3 queries, duplicate snapshots, both counter aliases, null/bad
evidence, provider loss, original-request recovery, SQL price save/read, and
source display followed by immediate browser refresh. All provider responses
are countable fixtures conforming to the selected contract, not live calls.

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

First inspect the existing OpenRouter account plugin/override-lock/preset state
read-only, without showing credentials. Resolve the prohibition boundary before
any private or no-search probe. Then use existing `qwen/qwen3.8-27b` through the
exact OpenRouter endpoint for one public prompt: “搜索 OpenRouter 官方文档，概括
web search 工具的用途并列出来源。” A second public prompt prohibits search: “不要联网，
解释 HTTP 这个缩写。” Keep original request IDs, capture final structured usage and
annotations, verify original SQL reservation/settlement and displayed sources,
then refresh/recover with **zero additional provider dispatch or reservation**.

The proposed minimum is two generation requests, no automatic retry; query
count may be 0–N and cannot be presented as a two-query hard cap. A maximum
acceptable spend must be agreed and a genuinely enforceable existing account
budget verified before approval; request tool-step settings alone do not enforce
a hard dollar ceiling. No arbitrary budget is silently chosen here. The existing
AgentKey/Tavily path has separate optional acceptance and is not replaced or
implicitly authorized. No Gemini-direct setup is required. No new configuration,
refund, paid retry, explicit deployment or production operation is included.
