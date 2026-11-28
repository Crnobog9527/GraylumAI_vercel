/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { accountMetrics, suppliedWholeHistory, type EvidenceItem } from '../benchmark/metrics';
import { classifyAccount, excludeOffTopic, qualifyFetchedAccount } from '../benchmark/classify';
import { offTopic, topicRelevance } from '../benchmark/relevance';
import { authorizeBenchmarkFetch } from '../tools/authorize';
import { shortfallNotice } from './shortfall';
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

/** Newest post titles handed to the coach per account, each cut to this many characters. */
const VIEW_TITLES = 8;
const VIEW_TITLE_CHARS = 60;

/** The account's display name and newest distinct post titles, one line each. */
function accountView(profile: EvidenceItem, posts: EvidenceItem[]): { name?: string; recentTitles?: string } {
  const name = typeof profile.fields.name === 'string' && profile.fields.name.trim() ? profile.fields.name.trim().slice(0, 40) : undefined;
  const titles = [...new Set(posts.map(post => post.fields.title).filter((title): title is string => typeof title === 'string')
    .map(title => Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, VIEW_TITLE_CHARS).join('')).filter(Boolean))].slice(0, VIEW_TITLES);
  return { ...(name ? { name } : {}), ...(titles.length ? { recentTitles: titles.join(' ｜ ') } : {}) };
}

/**
 * Owner 2026-11-28 (I, pay4 seq 28/30/32): three replies running asked the user to open the accounts and check them. The host already
 * has each account's name and newest titles: the coach judges from them first, asks the user at most once, and records "未核实".
 */
export const FETCH_JUDGE_NEXT_STEP = '每个账号的昵称（name）和最近作品标题（recentTitles）是系统取到的。先用它们给出你自己的判断：'
  + '这个账号做的是不是和用户同一类的内容、像不像用户要找的那类账号，并说依据是哪几条标题。标题看不出来的，直接写"未核实"。'
  + '不要让用户自己点开主页去核实。最多问用户一次补充；用户说看不出来，或者没有回答，就按"未核实"记下，以后不再追问。'
  + 'excluded 为 OFF_TOPIC 的账号，作品和用户确认的关键词对不上，不算合格对标。';

export async function benchmarkFetch(ctx: ResearchToolContext, args: ResearchToolArgs<'benchmark_fetch'>,
  budget: ToolAllowance): Promise<string> {
  // A user_message source without an id names the message this reply answers (this execution's own input).
  if (args.source.kind === 'user_message' && !args.source.messageId) args = { ...args, source: { ...args.source, messageId: ctx.executionId } };
  const authorization = await authorizeBenchmarkFetch(ctx.scope, args, ctx.store.authorization);
  if (!authorization.ok) return toolEnvelope({ status: 'not_confirmed', reason: authorization.reason });
  const rows: ResearchItem[] = [];
  let partial = false;
  // Read at most once per call, and only when an account was really fetched; a read failure only drops the label.
  let sessionKeywords: Promise<string[]> | undefined;
  const keywords = () => (sessionKeywords ??= (ctx.store.sessionKeywords?.() ?? Promise.resolve([])).catch(() => []));
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
    // Room for the account's own sub-calls plus any extra post pages its platform may need.
    const extraPages = BENCHMARK_EXTRA_POST_PAGES[account.platform] ?? 0;
    if (budget.left < routes.kinds.length + extraPages || ctx.lookupTime?.() === false) {
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
      const niche = await keywords();
      // Owner 2026-11-28 (H, pay4): an account that plainly makes other content than the confirmed niche never qualifies. An account
      // the user sent the link of is the user's own pick and is judged on its numbers only.
      const classification = excludeOffTopic(qualifyFetchedAccount(metrics, classifyAccount(metrics, ctx.config.recentGrowth, ctx.now())),
        args.source.kind !== 'user_message' && offTopic({ name: typeof profile.fields.name === 'string' ? profile.fields.name : null,
          posts, keywords: niche }));
      // BENCHMARK-COVERAGE: how much of the account is on the confirmed niche (the share offTopic decides by).
      const relevance = topicRelevance(posts, niche);
      const evidence = { ...account, metrics, classification, ...(relevance ? { relevance } : {}), fetchedAt: ctx.now().toISOString() };
      await ctx.store.fetchFinish(claim.fetchId, claim.attempt, 'succeeded', evidence);
      // What the coach judges the account by (pay4 2026-11-28, I): its name and newest post titles, for this reply only (not saved).
      rows.push({ fields: { ...account, ...accountView(profile, posts), evidence: JSON.stringify(evidence) }, missing: metrics.missing });
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
  // The fetch went through every selected account (none left for a later reply): the qualified count is final for this
  // selection, so the host may now offer the shortfall choice (0320 decides). A stop (round limit, balance) is not the end.
  const shortfall = stopReason ? undefined : await shortfallNotice(ctx);
  return toolEnvelope({ status: stopReason && rows.length === 0 ? (stopBudget ? 'budget_exhausted' : 'unavailable')
    : partial ? 'partial' : 'ok', reason: stopReason ?? (partial ? 'ACCOUNT_DATA_INCOMPLETE' : null), items: rows,
    ...(rows.some(row => typeof row.fields.recentTitles === 'string') ? { nextStep: FETCH_JUDGE_NEXT_STEP } : {}),
    ...(shortfall ? { shortfall } : {}) });
}
