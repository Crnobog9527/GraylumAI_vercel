/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The positioning research tools. RT-3b PR-3 offers the frozen subset in a mentor turn (researchExecution.ts).
import { z } from 'zod';
import type { RuntimeTool } from './runner';
import { admitSubcalls, POSITIONING_RESEARCH_TOOLS, RESEARCH_TOOL_DESCRIPTIONS, researchToolArgs, subcallNeed,
  type ResearchToolName } from '../research/tools/schemas';
import { statusForOutcome, toolEnvelope } from '../research/tools/envelope';
import { selectRoute, type ResearchToolsConfig } from '../research/vendors/config';
import { parallelModeFor } from '../research/vendors/parallel';
import { benchmarkFetch } from '../research/runtime/benchmarkFetch';
import { discover, moreCandidates } from '../research/runtime/discovery';
import { executeResearchCall, stableResearchId, type ResearchToolContext } from '../research/runtime/toolContext';
import { requestIdentity, type SupplierRequest } from '../research/runtime/subcall';
import { FREE_CHAT_RESEARCH_CALLS } from './researchTurn';
import { socialAccount, socialSearch, type AccountSources } from './researchSocialTool';

const savedWebResult = z.object({
  outcome: z.enum(['ok', 'partial', 'failed', 'not_sent', 'unknown']), reason: z.string().nullable(),
  fetchedAt: z.string(), truncated: z.boolean(), items: z.array(z.object({ url: z.string().optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), missing: z.array(z.string()) })),
});

// SDK requires object parameters; the authoritative strict union is parsed before execution.
const discoveryParameters = z.object({ keywordConfirmationId: z.string().uuid().optional(),
  platforms: z.array(z.string()).optional(), discoveryId: z.string().uuid().optional() }).strict();
/** RT-3b PR-3: a mentor turn has one research slot; the reply after the result ends the turn (terminalReplyGuard). */
const ONE_CALL = 'At most one research tool call per reply; then answer from its result.';
/** CHAT-AUTO-CONTEXT C: a free chat reply may look up a few different things (plan §2.3.2). */
const FREE_CHAT_CALLS = `At most ${FREE_CHAT_RESEARCH_CALLS} research tool calls per reply, one tool call at a time; ` +
  'answer as soon as you have enough. Every number must come from a tool result.';
const ACCOUNT_SOURCE = ' Only an account from the user\'s benchmark table (read_source) or with a profile link in the message you are answering.';
/** The description the model sees for one research tool. */
export const researchToolDescription = (name: ResearchToolName, freeChat = false): string =>
  `${RESEARCH_TOOL_DESCRIPTIONS[name]} ${freeChat ? FREE_CHAT_CALLS : ONE_CALL}${freeChat && name === 'social_account' ? ACCOUNT_SOURCE : ''}`;
/** web_search without a frozen advanced route offers only the fast mode, so the one research call cannot miss (#1029 P2). */
const fastSearchParameters = researchToolArgs.web_search.extend({ mode: z.enum(['fast']).default('fast') }).strict();
/** The parameters the model sees for one research tool (admission sizes the request with them). */
export const researchToolParameters = (name: ResearchToolName, fastSearchOnly = false): z.ZodObject<z.ZodRawShape> =>
  name === 'benchmark_discover' ? discoveryParameters
    : name === 'web_search' && fastSearchOnly ? fastSearchParameters as unknown as z.ZodObject<z.ZodRawShape>
      : researchToolArgs[name] as z.ZodObject<z.ZodRawShape>;
/** Whether a turn's frozen routes lack the advanced web search. */
export const fastSearchOnly = (config: Pick<ResearchToolsConfig, 'routes'>) =>
  !config.routes.some(route => route.platform === 'web' && route.kind === 'web_search_pro');

export interface ResearchToolOptions {
  /** CHAT-AUTO-CONTEXT C: free chat descriptions, the per-reply call limit and the account sources of social_account. */
  freeChat?: { accounts: AccountSources };
  /** Subcalls this answer already made (saved before a pause or restart), so a resumed answer never gets a fresh round. */
  usedSubcalls?: () => Promise<number>;
}

/** `names`: the tools this turn froze (RT-3b PR-3); the PR-1 default offers the whole positioning set. */
export function researchRuntimeTools(ctx: ResearchToolContext, names: readonly ResearchToolName[] = POSITIONING_RESEARCH_TOOLS,
  options: ResearchToolOptions = {}): RuntimeTool[] {
  let remaining: number | undefined;
  let calls = 0;
  const freeChat = options.freeChat;
  const make = (name: ResearchToolName): RuntimeTool => ({
    name, description: researchToolDescription(name, Boolean(freeChat)), parameters: researchToolParameters(name, fastSearchOnly(ctx.config)),
    async execute(raw, callId) {
      // Replayed calls of a resumed answer run through here again, so this count is rebuilt in order.
      if (freeChat && ++calls > FREE_CHAT_RESEARCH_CALLS) return toolEnvelope({ status: 'budget_exhausted', reason: 'REPLY_CALL_LIMIT' });
      const parsed = researchToolArgs[name].safeParse(raw);
      if (!parsed.success) return toolEnvelope({ status: 'not_confirmed', reason: 'INVALID_ARGUMENTS' });
      if (!ctx.config.enabled) return toolEnvelope({ status: 'unavailable', reason: 'RESEARCH_DISABLED' });
      remaining ??= Math.max(0, ctx.config.limits.maxSubcallsPerRound - (await options.usedSubcalls?.() ?? 0));
      const allowance = admitSubcalls(subcallNeed(name, parsed.data, ctx.config), remaining);
      // Social lookups check their own allowance after reading what this answer already saved (researchSocialTool).
      if (allowance.exhausted && !['web_search', 'web_fetch', 'benchmark_fetch', 'social_search', 'social_account'].includes(name)) {
        return toolEnvelope({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
      }
      // A social lookup budgets only the steps it has not saved yet (a lookup paused after paying for some continues after a
      // top-up), so it gets what is left of the round and checks its own steps (researchSocialTool).
      const budget = { left: name === 'social_search' || name === 'social_account' ? remaining : allowance.allowed, used: 0 };
      try {
        if (name === 'propose_keywords') {
          const args = researchToolArgs.propose_keywords.parse(raw);
          const options = args.keywords.map((text, i) => ({ id: `k${i}`, text }));
          const card = await ctx.store.createCard(stableResearchId(ctx.executionId, callId), { kind: 'keywords', options });
          ctx.emit({ type: 'research_card', card: { ...card, kind: 'keywords', options } });
          return toolEnvelope({ status: 'ok', items: [{ fields: { cardId: card.cardId }, missing: [] }] });
        }
        if (name === 'propose_more_candidates') {
          return moreCandidates(ctx, researchToolArgs.propose_more_candidates.parse(raw).discoveryId, callId);
        }
        if (name === 'benchmark_discover') return await discover(ctx, researchToolArgs.benchmark_discover.parse(raw), budget);
        if (name === 'benchmark_fetch') return await benchmarkFetch(ctx, researchToolArgs.benchmark_fetch.parse(raw), budget);
        if (name === 'social_search') return await socialSearch(ctx, researchToolArgs.social_search.parse(raw), budget, callId, raw);
        if (name === 'social_account') {
          if (!freeChat) return toolEnvelope({ status: 'not_confirmed', reason: 'ACCOUNT_NOT_CONFIRMED' });
          return await socialAccount(ctx, researchToolArgs.social_account.parse(raw), budget, callId, raw, freeChat.accounts);
        }
        let request: SupplierRequest;
        if (name === 'web_search') {
          const args = researchToolArgs.web_search.parse(raw);
          const route = selectRoute(ctx.config, 'web', args.mode === 'pro' ? 'web_search_pro' : 'web_search');
          if (!route.ok) return toolEnvelope({ status: 'unavailable', reason: route.reason });
          request = { vendor: 'parallel', route: route.route, query: args.query, mode: parallelModeFor(args.mode) };
        } else {
          const args = researchToolArgs.web_fetch.parse(raw);
          const route = selectRoute(ctx.config, 'web', 'web_fetch');
          if (!route.ok) return toolEnvelope({ status: 'unavailable', reason: route.reason });
          request = { vendor: 'firecrawl', route: route.route, url: args.url };
        }
        const operationId = stableResearchId(ctx.executionId, callId);
        const prior = await ctx.store.readOperation(operationId);
        if (prior && prior.identityHash !== requestIdentity(request)) {
          return toolEnvelope({ status: 'unavailable', reason: 'OPERATION_IDENTITY_MISMATCH' });
        }
        if (prior?.state === 'cancelled') return toolEnvelope({ status: 'unavailable', reason: 'NOT_DISPATCHED' });
        if (prior && prior.state !== 'prepared') {
          const saved = savedWebResult.safeParse(prior.result);
          if (!['succeeded', 'failed', 'unknown'].includes(prior.state) || !saved.success) {
            return toolEnvelope({ status: 'unavailable', reason: 'PROVIDER_RESULT_UNKNOWN' });
          }
          return toolEnvelope({ ...statusForOutcome(saved.data), items: saved.data.items,
            evidenceId: operationId, fetchedAt: saved.data.fetchedAt, truncated: saved.data.truncated });
        }
        if (allowance.exhausted) return toolEnvelope({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
        const outcome = await executeResearchCall(ctx, budget, request, operationId, name, raw);
        return outcome.sent ? toolEnvelope({ ...statusForOutcome(outcome.result), items: outcome.result.items,
          evidenceId: outcome.operationId, fetchedAt: outcome.result.fetchedAt, truncated: outcome.result.truncated })
          : toolEnvelope({ status: outcome.budget ? 'budget_exhausted' : 'unavailable', reason: outcome.stop });
      } finally { remaining = Math.max(0, (remaining ?? 0) - budget.used); }
    },
  });
  return names.map(make);
}
