/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { accountMetrics, suppliedWholeHistory, type EvidenceItem } from '../benchmark/metrics';
import { classifyAccount, qualifyFetchedAccount } from '../benchmark/classify';
import { authorizeBenchmarkFetch } from '../tools/authorize';
import { toolEnvelope } from '../tools/envelope';
import type { ResearchToolArgs } from '../tools/schemas';
import { BENCHMARK_EXTRA_POST_PAGES, BENCHMARK_ROUTE_KINDS, BENCHMARK_RULES } from '../vendors/config';
import type { ResearchItem, SocialKind } from '../vendors/types';
import { ResearchPause, type SubcallOutcome } from './subcall';
import { executeResearchCall, socialRequest, stableResearchId, type ResearchToolContext, type ToolAllowance } from './toolContext';

/** A subcall this attempt already finished before a balance pause: its saved result, never a second claim or request. */
async function savedSubcall(ctx: ResearchToolContext, operationId: string): Promise<SubcallOutcome | null> {
  const prior = await ctx.store.readOperation(operationId);
  if (!prior || prior.state === 'prepared') return null;
  const saved = prior.result ?? {};
  const outcome = prior.state === 'succeeded' && (saved.outcome === 'ok' || saved.outcome === 'partial') ? saved.outcome
    : prior.state === 'succeeded' || prior.state === 'failed' ? 'failed' : prior.state === 'cancelled' ? 'not_sent' : 'unknown';
  // callId is not read for a saved subcall; its BILL2 row was settled by the run that sent it.
  return { sent: true, operationId, callId: operationId, result: { vendor: 'tikhub', route: String(saved.route ?? ''), outcome,
    reason: typeof saved.reason === 'string' ? saved.reason : null, httpStatus: null,
    supplierMayCharge: outcome !== 'not_sent' && saved.supplierMayCharge !== false,
    usage: { unit: 'call', units: null }, items: Array.isArray(saved.items) ? saved.items as ResearchItem[] : [],
    truncated: saved.truncated === true, fetchedAt: String(saved.fetchedAt ?? ''),
    ...(typeof saved.nextCursor === 'string' ? { nextCursor: saved.nextCursor } : {}) } };
}

export async function benchmarkFetch(ctx: ResearchToolContext, args: ResearchToolArgs<'benchmark_fetch'>,
  budget: ToolAllowance): Promise<string> {
  // A user_message source without an id names the message this reply answers (this execution's own input).
  if (args.source.kind === 'user_message' && !args.source.messageId) args = { ...args, source: { ...args.source, messageId: ctx.executionId } };
  const authorization = await authorizeBenchmarkFetch(ctx.scope, args, ctx.store.authorization);
  if (!authorization.ok) return toolEnvelope({ status: 'not_confirmed', reason: authorization.reason });
  const rows: ResearchItem[] = [];
  let partial = false;
  let stopReason: string | null = null;
  let stopBudget = false;
  for (const account of authorization.accounts) {
    const routes = BENCHMARK_ROUTE_KINDS[account.platform];
    if (!routes?.verified || routes.kinds.some(kind => !socialRequest(ctx, account.platform, kind, { account: account.account }))) {
      partial = true;
      continue;
    }
    const refreshId = args.source.kind === 'refresh' ? args.source.refreshId : undefined;
    let claim = await ctx.store.fetchClaim(account.platform, account.account, refreshId);
    // A balance pause left this answer's own attempt in progress: continue it after the top-up (BILL-PAYG, 0279).
    if (!claim.claimed && claim.state === 'in_progress') {
      const own = await ctx.store.fetchResume(account.platform, account.account, refreshId);
      if (own) claim = { claimed: true, ...own, resumed: true };
    }
    if (!claim.claimed) {
      if (claim.evidence) rows.push({ fields: { platform: account.platform, account: account.account,
        evidence: JSON.stringify(claim.evidence) }, missing: [] });
      else partial = true;
      continue;
    }
    // Cached evidence is free. Only a newly claimed attempt needs a full account allowance.
    // Room for the account's own sub-calls plus the extra post pages its platform may need (Xiaohongshu).
    const extraPages = BENCHMARK_EXTRA_POST_PAGES[account.platform] ?? 0;
    if (budget.left < routes.kinds.length + extraPages) {
      partial = true;
      stopReason = 'ROUND_LIMIT';
      stopBudget = true;
      break;
    }
    // A resumed attempt was marked sent before its balance pause; only this run's own dispatch may close it on an error.
    let dispatched = claim.resumed === true;
    let dispatchedHere = false;
    let supplierStarted = false;
    const fetchContext = { ...ctx, subcall: { ...ctx.subcall,
      beforeSend: async () => {
        if (ctx.subcall.beforeSend && !await ctx.subcall.beforeSend()) return false;
        if (!dispatched) dispatched = dispatchedHere = await ctx.store.fetchDispatch(claim.fetchId, claim.attempt);
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
        const operationId = stableResearchId(claim.fetchId, claim.attempt, kind);
        const outcome = (claim.resumed ? await savedSubcall(ctx, operationId) : null)
          ?? await executeResearchCall(fetchContext, budget, request, operationId, 'benchmark_fetch', args);
        if (!outcome.sent) {
          failed = true;
          stopReason = outcome.stop;
          stopBudget = outcome.budget;
          break;
        }
        charged ||= outcome.result.supplierMayCharge;
        unknown ||= outcome.result.outcome === 'unknown';
        if (!['ok', 'partial'].includes(outcome.result.outcome)) { failed = true; break; }
        results[kind] = outcome.result.items.map((item, i) => ({ ...item, ref: `${outcome.operationId}#${i + 1}` }));
        // One page can fall short of the 20-post rule while the supplier has more: follow its cursor, each page a billed
        // sub-call with its own stable id (a resumed attempt reads saved pages instead of sending again).
        let cursor = kind === 'account_posts' ? outcome.result.nextCursor : undefined;
        for (let page = 2; cursor && page <= 1 + extraPages && (results.account_posts?.length ?? 0) < BENCHMARK_RULES.postsMin; page++) {
          const pageRequest = socialRequest(ctx, account.platform, kind, { account: account.account, cursor });
          if (!pageRequest) { failed = true; break; }
          const pageId = stableResearchId(claim.fetchId, claim.attempt, kind, String(page));
          const next = (claim.resumed ? await savedSubcall(ctx, pageId) : null)
            ?? await executeResearchCall(fetchContext, budget, pageRequest, pageId, 'benchmark_fetch', args);
          if (!next.sent) { failed = true; stopReason = next.stop; stopBudget = next.budget; break; }
          charged ||= next.result.supplierMayCharge;
          unknown ||= next.result.outcome === 'unknown';
          if (!['ok', 'partial'].includes(next.result.outcome)) { failed = true; break; }
          const known = new Set((results.account_posts ?? []).map(post => post.fields.id));
          results.account_posts = [...(results.account_posts ?? []), ...next.result.items
            .map((item, i) => ({ ...item, ref: `${next.operationId}#${i + 1}` })).filter(item => !known.has(item.fields.id))];
          cursor = next.result.nextCursor;
        }
        if (failed) break;
      }
      const profile = results.account_profile?.[0] ?? results.post_detail?.[0];
      const posts = results.account_posts;
      if (failed || !profile || !posts) {
        if (dispatched) {
          await ctx.store.fetchFinish(claim.fetchId, claim.attempt, unknown ? 'unknown' : charged ? 'failed_charged' : 'failed', null);
        }
        if (profile) {
          const metrics = accountMetrics({ profile, posts: posts ?? [], followersItem: results[routes.followersFrom]?.[0],
            complete: suppliedWholeHistory(results.account_profile?.[0], posts ?? []) }, ctx.now());
          rows.push({ fields: { ...account, evidence: JSON.stringify({ ...account, metrics, partial: true }) }, missing: metrics.missing });
        }
        partial = true;
        if (stopReason) break;
        continue;
      }
      // Whole history only when the profile's own post count shows nothing is left (Owner 2026-10-16, A: new accounts).
      const metrics = accountMetrics({ profile, posts, followersItem: results[routes.followersFrom]?.[0],
        complete: suppliedWholeHistory(results.account_profile?.[0], posts) }, ctx.now());
      const classification = qualifyFetchedAccount(metrics, classifyAccount(metrics, ctx.config.recentGrowth, ctx.now()));
      const evidence = { ...account, metrics, classification, fetchedAt: ctx.now().toISOString() };
      await ctx.store.fetchFinish(claim.fetchId, claim.attempt, 'succeeded', evidence);
      rows.push({ fields: { ...account, evidence: JSON.stringify(evidence) }, missing: metrics.missing });
    } catch (error) {
      // A failure after dispatch can conceal a supplier response. Never make this attempt retryable.
      // Keep an unsent prepared attempt recoverable (including its original refresh grant). A balance pause keeps the
      // attempt in progress: the resumed answer continues it, reusing what it already paid for (BILL-PAYG).
      if (dispatchedHere && !(error instanceof ResearchPause)) {
        await ctx.store.fetchFinish(claim.fetchId, claim.attempt, supplierStarted ? 'unknown' : 'failed', null);
      }
      throw error;
    }
  }
  return toolEnvelope({ status: stopReason && rows.length === 0 ? (stopBudget ? 'budget_exhausted' : 'unavailable')
    : partial ? 'partial' : 'ok', reason: stopReason ?? (partial ? 'ACCOUNT_DATA_INCOMPLETE' : null), items: rows });
}
