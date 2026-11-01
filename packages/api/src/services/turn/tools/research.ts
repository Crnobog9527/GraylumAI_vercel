/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, randomUUID } from 'node:crypto';
import { decimal } from '../../bill2/decimal';
import type { ToolCallPolicy } from '../../bill2/toolBilling';
import { canonicalAccount, profileLinksIn, type CanonicalAccount } from '../../research/tools/accountLinks';
import { toolEnvelope, type ToolEnvelope } from '../../research/tools/envelope';
import { admitSubcalls, researchToolArgs, subcallNeed, withoutNulls, type ResearchToolArgs } from '../../research/tools/schemas';
import { BENCHMARK_ROUTE_KINDS, selectRoute, type ResearchToolsConfig } from '../../research/vendors/config';
import { parallelModeFor } from '../../research/vendors/parallel';
import type { ResearchItem, SocialKind, SocialPlatform } from '../../research/vendors/types';
import type { SupplierRequest } from '../../research/runtime/subcall';
import { callDisplay } from '../../research/runtime/toolContext';
import type { ResearchTurnEvent } from '../../../shared/researchTurn';
import { INVALID_RESEARCH_ARGUMENTS, fastSearchOnly, researchToolDescription, researchToolParameters } from '../../runtime/researchRuntimeTool';
import type { RuntimeTool } from '../../runtime/runner';
import type { TurnReplay } from '../resume';
import { paidToolCall, subcallCredits, ToolLimitReached, type SubcallLedger } from './meter';
import { routePolicy, supplierSubcall, type SupplierDeps } from './suppliers';
import type { GeneralResearchToolName, ToolCallDeps, ToolCallOutcome } from './types';

/*
 * CORE-PATH-V2 V2-6 (CHAT-AUTO-CONTEXT C rules, now on the turn core): the general research lookups of a free chat.
 * social_search sends one keyword_posts subcall per keyword; social_account the platform's account route set (YouTube adds
 * one post_detail after the posts); web_search one Parallel search; web_fetch one Firecrawl scrape. Each tool call is one
 * paid turn_calls row (meter.ts); a call the turn cannot afford (call limit, subcall allowance) or cannot route is refused
 * before anything is written or sent. Nothing here writes a benchmark table.
 */
const DEFAULT_POSTS = 20;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item);

/** The explicit "ran but returned nothing" result (product observation: a Xiaohongshu search answered "这次没取到数据"). */
export const NO_DATA_REASON = 'NO_DATA_RETURNED';

export type ResearchToolsInput = {
  /** A resume: the receipts that answer calls already paid for (resume.ts). */
  replay?: TurnReplay;
  calls: ToolCallDeps; suppliers: SupplierDeps; config: ResearchToolsConfig;
  /** The tools this turn may use (ToolPlan.available ∩ research); offered-but-trimmed tools answer unavailable. */
  names: readonly GeneralResearchToolName[]; offered: readonly GeneralResearchToolName[];
  /** Paid tool calls and supplier subcalls the turn froze (2.5.3). */
  maxCalls: number; maxSubcalls: number;
  /** Where social_account may take an account from: the user's benchmark table and the message this turn answers. */
  accounts: { benchmark: readonly CanonicalAccount[]; currentMessage: string };
  onOutcome?: (name: GeneralResearchToolName, outcome: ToolCallOutcome, subcalls: number) => void;
  /** The one-switch pause and the call limits for this call's subcalls (newWorkGate); throws TurnStop to refuse. */
  callGate?: (subcalls: number) => Promise<void>;
  /** One line per subcall for the page (the mentor's `research_call` format), and the turn's credits per USD for its amount. */
  onCall?: { emit: (event: Extract<ResearchTurnEvent, { type: 'research_call' }>) => void; q: string };
};

type Step = { request: SupplierRequest; label: ResearchItem['fields'] };

function tikhub(config: ResearchToolsConfig, platform: SocialPlatform, kind: SocialKind,
  input: { account?: string; keyword?: string; postId?: string }, limit: number): SupplierRequest | null {
  const route = selectRoute(config, platform, kind);
  if (!route.ok || route.vendor !== 'tikhub') return null;
  return { vendor: 'tikhub', route: route.route, call: { platform, kind, ...input, limit } };
}

/** Whether social_account may look this account up (the benchmark table, or a profile link in the current message). */
export function accountAllowed(accounts: ResearchToolsInput['accounts'], platform: SocialPlatform, value: string): string | null {
  const account = canonicalAccount(platform, value);
  if (account === null) return null;
  const same = (item: CanonicalAccount) => item.platform === platform && item.account === account;
  return accounts.benchmark.some(same) || profileLinksIn(accounts.currentMessage).some(same) ? account : null;
}

/** `later`: requests that may be added while the call runs (YouTube's post detail); the call's bound covers them too. */
type Planned = { steps: Step[]; later?: SupplierRequest[]; next?: (step: Step, items: ResearchItem[]) => Step | undefined }
  | { refused: string };

function planSteps(input: ResearchToolsInput, name: GeneralResearchToolName, args: Record<string, unknown>): Planned {
  const config = input.config;
  if (name === 'social_search') {
    const a = args as ResearchToolArgs<'social_search'>;
    const steps: Step[] = [];
    for (const keyword of a.keywords) {
      const request = tikhub(config, a.platform, 'keyword_posts', { keyword }, a.limit ?? DEFAULT_POSTS);
      if (!request) return { refused: 'ROUTE_NOT_SUPPORTED' };
      steps.push({ request, label: { platform: a.platform, keyword } });
    }
    return { steps };
  }
  if (name === 'social_account') {
    const a = args as ResearchToolArgs<'social_account'>;
    const account = accountAllowed(input.accounts, a.platform, a.account);
    if (!account) return { refused: 'ACCOUNT_NOT_CONFIRMED' };
    const kinds = BENCHMARK_ROUTE_KINDS[a.platform]?.kinds;
    const posts = a.posts ?? DEFAULT_POSTS;
    const step = (kind: SocialKind, postId?: string): Step | null => {
      const request = tikhub(config, a.platform, kind, { account, ...(postId ? { postId } : {}) }, posts);
      return request && { request, label: { platform: a.platform, account, dataKind: kind } };
    };
    const first = kinds?.filter(kind => kind !== 'post_detail').map(kind => step(kind));
    const detail = kinds?.includes('post_detail') ? step('post_detail', 'x') : undefined;
    if (!kinds || !first?.length || first.some(item => !item) || detail === null) return { refused: 'ROUTE_NOT_SUPPORTED' };
    // YouTube: post_detail needs a post id from account_posts, so it follows once those came back.
    return { steps: first as Step[], ...(detail ? { later: [detail.request] } : {}), next: (current, items) => {
      if (!kinds.includes('post_detail') || current.request.vendor !== 'tikhub' || current.request.call.kind !== 'account_posts') return;
      const postId = items[0]?.fields.id;
      return typeof postId === 'string' ? step('post_detail', postId) ?? undefined : undefined;
    } };
  }
  if (name === 'web_search') {
    const a = args as ResearchToolArgs<'web_search'>;
    const route = selectRoute(config, 'web', a.mode === 'pro' ? 'web_search_pro' : 'web_search');
    if (!route.ok) return { refused: route.reason };
    return { steps: [{ request: { vendor: 'parallel', route: route.route, query: a.query, mode: parallelModeFor(a.mode) },
      label: { query: a.query } }] };
  }
  const a = args as ResearchToolArgs<'web_fetch'>;
  const route = selectRoute(config, 'web', 'web_fetch');
  if (!route.ok) return { refused: route.reason };
  return { steps: [{ request: { vendor: 'firecrawl', route: route.route, url: a.url }, label: { url: a.url } }] };
}

/** Runs the steps in order; stops at the first one without data; returns what came back. */
/** `call`: this tool call's number in the turn, so refs never repeat across calls (`c<call>s<subcall>#<item>`). */
type SupplierReceipt = Awaited<ReturnType<typeof supplierSubcall>>;
/** A replayed call adds to no row: it only keeps the count runSteps numbers its items by. */
const replayLedger = (): SubcallLedger => {
  const receipts: Parameters<SubcallLedger['add']>[0][] = [];
  return { receipts, add: receipt => { receipts.push(receipt); } };
};

async function runSteps(input: ResearchToolsInput, ledger: SubcallLedger, planned: Extract<Planned, { steps: Step[] }>, call: number,
  tool: { toolName: string; args: Record<string, unknown> }, stored?: readonly SupplierReceipt['result'][]) {
  const items: ToolEnvelope['items'] = [];
  const steps = [...planned.steps];
  let stoppedAt: string | null = null, fetchedAt: string | undefined, cut: string | null = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const line = { callId: randomUUID(), ...tool, ...callDisplay(step.request) };
    input.onCall?.emit({ type: 'research_call', ...line, state: 'running' });
    const result0 = stored?.[i];
    const receipt = result0 ? { result: result0, costUsd: null, multiplier: '1' } as SupplierReceipt : await supplierSubcall(input.suppliers, step.request);
    ledger.add(receipt);
    const result = receipt.result;
    const answered = ['ok', 'partial'].includes(result.outcome) ? 'succeeded' as const : 'failed' as const;
    input.onCall?.emit({ type: 'research_call', ...line, ...result.outcome === 'not_sent' ? { state: 'failed' as const } : {
      state: result.outcome === 'unknown' ? 'unknown' as const : answered,
      evidenceId: line.callId, credits: subcallCredits(receipt, input.onCall.q) } });
    if (result.outcome !== 'ok' && result.outcome !== 'partial') { stoppedAt = result.reason ?? result.outcome; break; }
    fetchedAt ??= result.fetchedAt;
    // A supplier answer cut to its item or byte limit stays partial: the model is told data is missing.
    if (result.outcome === 'partial' || result.truncated) cut ??= result.reason ?? 'RESULT_TRUNCATED';
    const n = ledger.receipts.length;
    items.push(...result.items.map((item, index) => ({ ...(item.url ? { url: item.url } : {}),
      fields: { ...item.fields, ...step.label, ref: `c${call}s${n}#${index + 1}` }, missing: item.missing })));
    const following = planned.next?.(step, result.items);
    if (following) steps.splice(i + 1, 0, following);
  }
  return { items, stoppedAt, cut, fetchedAt, subcalls: ledger.receipts.filter(r => r.result.outcome !== 'not_sent').length };
}

/** The bound of one call: its worst-case subcalls at the highest frozen route price, and the highest route multiplier. */
export function callBound(policies: readonly ToolCallPolicy[], requests: readonly SupplierRequest[], subcalls: number) {
  const priced = requests.map(request => routePolicy(policies, request));
  if (!priced.length || priced.some(policy => !policy)) return null;
  const upper = priced.reduce((max, p) => decimal(p!.upperUsd) > max ? decimal(p!.upperUsd) : max, 0n) * BigInt(subcalls);
  const multiplier = priced.reduce((max, p) => decimal(p!.multiplier) > decimal(max) ? p!.multiplier : max, priced[0]!.multiplier);
  const whole = upper / 1_000_000_000_000n, fraction = (upper % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return { upperUsd: fraction ? `${whole}.${fraction}` : String(whole), multiplier };
}

export function researchTools(input: ResearchToolsInput): RuntimeTool[] {
  let calls = 0, started = 0, subcallsLeft = input.maxSubcalls;
  const fastOnly = fastSearchOnly(input.config);
  const make = (name: GeneralResearchToolName): RuntimeTool => ({
    name, description: researchToolDescription(name, true), parameters: researchToolParameters(name, fastOnly),
    invalidResult: INVALID_RESEARCH_ARGUMENTS, invalidInputOnly: true,
    // Withdrawn only once used up within the turn; a turn that may make none keeps the definition (2.9 rule 2) and answers unavailable.
    enabled: () => input.maxCalls === 0 || calls < input.maxCalls,
    async execute(offered) {
      if (!input.names.includes(name)) return toolEnvelope({ status: 'unavailable', reason: 'TOOL_UNAVAILABLE_THIS_TURN' });
      if (calls >= input.maxCalls) return toolEnvelope({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' });
      const raw = withoutNulls(offered) as Record<string, unknown>;
      const parsed = researchToolArgs[name].safeParse(raw);
      if (!parsed.success) return toolEnvelope({ status: 'not_confirmed', reason: 'INVALID_ARGUMENTS' });
      const planned = planSteps(input, name, parsed.data as Record<string, unknown>);
      if ('refused' in planned) return toolEnvelope({ status: planned.refused === 'ACCOUNT_NOT_CONFIRMED' ? 'not_confirmed'
        : planned.refused === 'ROUTE_NOT_SUPPORTED' ? 'not_supported' : 'unavailable', reason: planned.refused });
      // General lookups are all or nothing: the whole worst case must fit what the turn has left.
      const need = subcallNeed(name, parsed.data as never, input.config);
      const allowance = admitSubcalls(need, subcallsLeft);
      if (allowance.exhausted) return toolEnvelope({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
      const bound = callBound(input.suppliers.policies, [...planned.steps.map(step => step.request), ...planned.later ?? []],
        allowance.allowed);
      if (!bound) return toolEnvelope({ status: 'unavailable', reason: 'ROUTE_NOT_FROZEN' });
      // A resume: the paused turn paid for this call; its supplier results answer it, with no row and no request (resume.ts).
      const stored = input.replay?.tool(name);
      let metered;
      if (stored) {
        metered = { value: await runSteps(input, replayLedger(), planned, ++started,
          { toolName: name, args: parsed.data as Record<string, unknown> }, stored.results as SupplierReceipt['result'][]),
          outcome: (stored.status === 'ok' ? 'delivered' : 'no_data') as ToolCallOutcome };
      } else try {
        // Refused here: nothing is written or sent, and the turn stops (the gate's TurnStop passes).
        await input.callGate?.(allowance.allowed);
        metered = await paidToolCall(input.calls, { toolName: name, requestHash: sha256(canonical({ name, args: parsed.data })),
          upperUsd: bound.upperUsd, multiplier: bound.multiplier }, ledger =>
            runSteps(input, ledger, planned, ++started, { toolName: name, args: parsed.data as Record<string, unknown> }));
      } catch (error) {
        if (error instanceof ToolLimitReached) { calls = input.maxCalls; return toolEnvelope({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' }); }
        throw error;
      }
      const { value, outcome } = metered;
      // The allowance is spent whole (it is what the call reserved); a call nothing was sent for spends nothing.
      if (outcome !== 'not_sent') { calls++; subcallsLeft = Math.max(0, subcallsLeft - allowance.allowed); }
      input.onOutcome?.(name, outcome, value.subcalls);
      if (outcome === 'not_sent') return toolEnvelope({ status: 'unavailable', reason: value.stoppedAt ?? 'NOT_SENT' });
      if (outcome === 'unknown') return toolEnvelope({ status: 'unavailable', reason: 'PROVIDER_RESULT_UNKNOWN',
        ...(value.items.length ? { items: value.items } : {}) });
      if (outcome === 'no_data') return toolEnvelope({ status: 'unavailable', reason: NO_DATA_REASON });
      return toolEnvelope({ status: value.stoppedAt || value.cut ? 'partial' : 'ok', reason: value.stoppedAt ?? value.cut,
        items: value.items, truncated: value.cut !== null,
        ...(value.fetchedAt ? { fetchedAt: value.fetchedAt } : {}) });
    },
  });
  return input.offered.map(make);
}
