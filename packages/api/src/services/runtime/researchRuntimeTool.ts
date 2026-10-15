/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PR-1 factory only. PR-2 attaches it to positioning admission; no runtime switch is changed here.
import { z } from 'zod';
import type { RuntimeTool } from './runner';
import { admitSubcalls, POSITIONING_RESEARCH_TOOLS, RESEARCH_TOOL_DESCRIPTIONS, researchToolArgs, subcallNeed,
  type ResearchToolName } from '../research/tools/schemas';
import { statusForOutcome, toolEnvelope } from '../research/tools/envelope';
import { selectRoute } from '../research/vendors/config';
import { parallelModeFor } from '../research/vendors/parallel';
import { benchmarkFetch } from '../research/runtime/benchmarkFetch';
import { discover, moreCandidates } from '../research/runtime/discovery';
import { executeResearchCall, stableResearchId, type ResearchToolContext } from '../research/runtime/toolContext';
import { requestIdentity, type SupplierRequest } from '../research/runtime/subcall';

const savedWebResult = z.object({
  outcome: z.enum(['ok', 'partial', 'failed', 'not_sent', 'unknown']), reason: z.string().nullable(),
  fetchedAt: z.string(), truncated: z.boolean(), items: z.array(z.object({ url: z.string().optional(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), missing: z.array(z.string()) })),
});

// SDK requires object parameters; the authoritative strict union is parsed before execution.
const discoveryParameters = z.object({ keywordConfirmationId: z.string().uuid().optional(),
  platforms: z.array(z.string()).optional(), discoveryId: z.string().uuid().optional() }).strict();

export function researchRuntimeTools(ctx: ResearchToolContext): RuntimeTool[] {
  let remaining = ctx.config.limits.maxSubcallsPerRound;
  const make = (name: ResearchToolName): RuntimeTool => ({
    name, description: RESEARCH_TOOL_DESCRIPTIONS[name],
    parameters: name === 'benchmark_discover' ? discoveryParameters : researchToolArgs[name] as z.ZodObject<z.ZodRawShape>,
    async execute(raw, callId) {
      const parsed = researchToolArgs[name].safeParse(raw);
      if (!parsed.success) return toolEnvelope({ status: 'not_confirmed', reason: 'INVALID_ARGUMENTS' });
      if (!ctx.config.enabled) return toolEnvelope({ status: 'unavailable', reason: 'RESEARCH_DISABLED' });
      const allowance = admitSubcalls(subcallNeed(name, parsed.data, ctx.config), remaining);
      if (allowance.exhausted && !['web_search', 'web_fetch', 'benchmark_fetch'].includes(name)) {
        return toolEnvelope({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
      }
      const budget = { left: allowance.allowed, used: 0 };
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
      } finally { remaining = Math.max(0, remaining - budget.used); }
    },
  });
  return POSITIONING_RESEARCH_TOOLS.map(make);
}
