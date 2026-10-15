/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { accountMetrics, type EvidenceItem } from '../benchmark/metrics';
import { classifyAccount } from '../benchmark/classify';
import { authorizeBenchmarkFetch } from '../tools/authorize';
import { toolEnvelope } from '../tools/envelope';
import type { ResearchToolArgs } from '../tools/schemas';
import { BENCHMARK_ROUTE_KINDS } from '../vendors/config';
import type { ResearchItem, SocialKind } from '../vendors/types';
import { executeResearchCall, socialRequest, stableResearchId, type ResearchToolContext, type ToolAllowance } from './toolContext';

export async function benchmarkFetch(ctx: ResearchToolContext, args: ResearchToolArgs<'benchmark_fetch'>,
  budget: ToolAllowance): Promise<string> {
  const authorization = await authorizeBenchmarkFetch(ctx.scope, args, ctx.store.authorization);
  if (!authorization.ok) return toolEnvelope({ status: 'not_confirmed', reason: authorization.reason });
  const rows: ResearchItem[] = [];
  let partial = false;
  for (const account of authorization.accounts) {
    const routes = BENCHMARK_ROUTE_KINDS[account.platform];
    if (!routes?.verified || routes.kinds.some(kind => !socialRequest(ctx, account.platform, kind, { account: account.account }))) {
      partial = true;
      continue;
    }
    // The complete account must fit before claiming its once-only paid fetch.
    if (budget.left < routes.kinds.length) { partial = true; break; }
    const claim = await ctx.store.fetchClaim(account.platform, account.account,
      args.source.kind === 'refresh' ? args.source.refreshId : undefined);
    if (!claim.claimed) {
      if (claim.evidence) rows.push({ fields: { platform: account.platform, account: account.account,
        evidence: JSON.stringify(claim.evidence) }, missing: [] });
      else partial = true;
      continue;
    }
    let dispatched = false;
    let supplierStarted = false;
    const fetchContext = { ...ctx, subcall: { ...ctx.subcall,
      beforeSend: async () => {
        if (ctx.subcall.beforeSend && !await ctx.subcall.beforeSend()) return false;
        if (!dispatched) dispatched = await ctx.store.fetchDispatch(claim.fetchId, claim.attempt);
        return dispatched;
      },
      onSupplierDispatch: () => { ctx.subcall.onSupplierDispatch?.(); supplierStarted = true; },
    } };
    const results: Partial<Record<SocialKind, EvidenceItem[]>> = {};
    let charged = false;
    let unknown = false;
    let failed = false;
    try {
      for (const kind of routes.kinds) {
        const postId = results.account_posts?.[0]?.fields.id;
        const request = socialRequest(ctx, account.platform, kind,
          { account: account.account, ...(typeof postId === 'string' ? { postId } : {}) });
        if (!request) { failed = true; break; }
        const outcome = await executeResearchCall(fetchContext, budget, request,
          stableResearchId(claim.fetchId, claim.attempt, kind), 'benchmark_fetch', args);
        if (!outcome.sent) { failed = true; break; }
        charged ||= outcome.result.supplierMayCharge;
        unknown ||= outcome.result.outcome === 'unknown';
        if (!['ok', 'partial'].includes(outcome.result.outcome)) { failed = true; break; }
        results[kind] = outcome.result.items.map((item, i) => ({ ...item, ref: `${outcome.operationId}#${i + 1}` }));
      }
      const profile = results.account_profile?.[0] ?? results.post_detail?.[0];
      const posts = results.account_posts;
      if (failed || !profile || !posts) {
        if (dispatched) {
          await ctx.store.fetchFinish(claim.fetchId, claim.attempt, unknown ? 'unknown' : charged ? 'failed_charged' : 'failed', null);
        }
        if (profile) {
          const metrics = accountMetrics({ profile, posts: posts ?? [], followersItem: results[routes.followersFrom]?.[0] }, ctx.now());
          rows.push({ fields: { ...account, evidence: JSON.stringify({ ...account, metrics, partial: true }) }, missing: metrics.missing });
        }
        partial = true;
        continue;
      }
      const metrics = accountMetrics({ profile, posts, followersItem: results[routes.followersFrom]?.[0] }, ctx.now());
      const classification = classifyAccount(metrics, ctx.config.recentGrowth, ctx.now());
      const evidence = { ...account, metrics, classification, fetchedAt: ctx.now().toISOString() };
      await ctx.store.fetchFinish(claim.fetchId, claim.attempt, 'succeeded', evidence);
      rows.push({ fields: { ...account, evidence: JSON.stringify(evidence) }, missing: metrics.missing });
    } catch (error) {
      // A failure after dispatch can conceal a supplier response. Never make this attempt retryable.
      // Keep an unsent prepared attempt recoverable (including its original refresh grant).
      if (dispatched) await ctx.store.fetchFinish(claim.fetchId, claim.attempt, supplierStarted ? 'unknown' : 'failed', null);
      throw error;
    }
  }
  return toolEnvelope({ status: partial ? 'partial' : 'ok', reason: partial ? 'ACCOUNT_DATA_INCOMPLETE' : null, items: rows });
}
