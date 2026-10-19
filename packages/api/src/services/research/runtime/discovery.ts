/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { aggregateAuthors, classifyAccount, selectCandidates, type ScoredAccount } from '../benchmark/classify';
import { accountMetrics, type EvidenceItem } from '../benchmark/metrics';
import { BENCHMARK_RULES } from '../vendors/config';
import { authorizeDiscoverStart } from '../tools/authorize';
import { canonicalAccount } from '../tools/accountLinks';
import { toolEnvelope } from '../tools/envelope';
import type { ResearchToolArgs } from '../tools/schemas';
import type { ResearchCandidateOption } from '../../../shared/researchTurn';
import type { ResearchItem, SocialPlatform } from '../vendors/types';
import { executeResearchCall, socialRequest, stableResearchId, type ResearchToolContext, type ToolAllowance } from './toolContext';
import type { DiscoveryRecord } from './store';
import { requestIdentity, type SupplierRequest } from './subcall';
import { shortfallNotice } from './shortfall';

const itemSchema = z.object({ url: z.string().optional(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  missing: z.array(z.string()) });
interface FoundAccount extends ScoredAccount { platform: SocialPlatform; account: string; evidenceRef: string }
interface StepResult {
  items: ResearchItem[]; operationId: string; complete: boolean; stopped: boolean;
  reason?: string; budget?: boolean;
}

export function candidateShortage(available: number) {
  const required = BENCHMARK_RULES.candidatesMin;
  return {
    message: `已找到 ${available} 个可选、需要 ${required} 个。`,
    nextStep: '建议换或补充关键词再找，或让用户贴账号主页链接以便取数核对。',
    availableCandidates: available,
    requiredCandidates: required,
  };
}

/** The operation is the durable cursor. A crash after dispatch never causes another supplier request. */
async function step(ctx: ResearchToolContext, d: DiscoveryRecord, budget: ToolAllowance,
  index: number, request: SupplierRequest): Promise<StepResult> {
  let operationId = stableResearchId(d.discoveryId, String(index));
  let prior = await ctx.store.readOperation(operationId);
  // A prior answer's unsent plan cannot be rebound to this answer's billing run. Cancel under the
  // existing plan lock, verify it really stayed unsent, then contend for one stable successor id.
  for (let recovery = 0; recovery < 20; recovery += 1) {
    let plan = await ctx.store.readPlan(operationId);
    if (plan && plan.executionId !== ctx.executionId && (!prior || prior.state === 'prepared')) {
      await ctx.store.cancelUnsentPlan(operationId);
      prior = await ctx.store.readOperation(operationId);
      plan = await ctx.store.readPlan(operationId);
      if (prior?.state === 'prepared' || (!prior && !plan?.cancelled)) {
        return { operationId, items: [], complete: false, stopped: true, reason: 'NOT_DISPATCHED' };
      }
    }
    if (prior?.state !== 'cancelled' && !(plan?.cancelled && !prior)) break;
    operationId = stableResearchId(operationId, 'unsent-successor');
    prior = await ctx.store.readOperation(operationId);
    if (recovery === 19) return { operationId, items: [], complete: false, stopped: true, reason: 'NOT_DISPATCHED' };
  }
  if (prior && prior.identityHash !== requestIdentity(request)) {
    return { operationId, items: [], complete: false, stopped: true, reason: 'OPERATION_IDENTITY_MISMATCH' };
  }
  if (prior && prior.state !== 'prepared') {
    const parsed = z.array(itemSchema).safeParse(prior.result?.items);
    return { operationId, items: parsed.success ? parsed.data : [],
      complete: prior.state === 'succeeded' && parsed.success, stopped: false };
  }
  if (budget.left === 0) return { operationId, items: [], complete: false, stopped: true, reason: 'ROUND_LIMIT', budget: true };
  const outcome = await executeResearchCall(ctx, budget, request, operationId, 'benchmark_discover',
    { discoveryId: d.discoveryId }, d.discoveryId);
  return { operationId, items: outcome.sent ? outcome.result.items : [],
    complete: outcome.sent && ['ok', 'partial'].includes(outcome.result.outcome), stopped: !outcome.sent,
    ...(!outcome.sent ? { reason: outcome.stop, budget: outcome.budget } : {}) };
}

async function card(ctx: ResearchToolContext, discoveryId: string, accounts: FoundAccount[], followUp: boolean, callId: string) {
  const chosen = followUp ? await ctx.store.selectedAccounts(discoveryId) : [];
  const keys = new Set(chosen.map(a => `${a.platform}:${a.account}`));
  const remaining = accounts.filter(a => !keys.has(a.key));
  const selection = selectCandidates(remaining, true);
  if ((!followUp && !selection.enough) || selection.selectable.length === 0) return false;
  const selectable = new Set(selection.selectable.map(a => a.key));
  const references = !followUp ? selection.headReferences.slice(0, 3) : [];
  const ordered = [...selection.selectable.slice(0, 12 - references.length), ...references] as FoundAccount[];
  const options: ResearchCandidateOption[] = ordered
    .map((a, i) => ({ id: `c${i}`, platform: a.platform, account: a.account, evidenceRef: a.evidenceRef,
      label: a.classification.excluded === 'ACTIVE_CHECK_PENDING'
        ? `${a.account} · 活跃度待核对` : a.account,
      selectable: selectable.has(a.key) }));
  const payload = { kind: 'candidates' as const, discoveryId, options: options.map(o => ({ ...o })),
    ...(followUp ? { followUp: true, minSelect: Math.min(options.length, Math.max(1, 3 - keys.size)) } : {}) };
  const cardId = stableResearchId(discoveryId, followUp ? callId : 'first-card');
  const saved = await ctx.store.readCard(cardId) ?? await ctx.store.createCard(cardId, payload);
  const savedOptions = saved.options as unknown as ResearchCandidateOption[];
  ctx.emit({ type: 'research_card', card: { ...saved, kind: 'candidates', options: savedOptions,
    ...(followUp ? { followUp: true } : {}) } });
  return true;
}

export async function discover(ctx: ResearchToolContext, args: ResearchToolArgs<'benchmark_discover'>,
  budget: ToolAllowance): Promise<string> {
  let d: DiscoveryRecord | null;
  if ('discoveryId' in args) d = await ctx.store.discoveryRead(args.discoveryId);
  else {
    const approved = await authorizeDiscoverStart(ctx.scope, args, ctx.store.authorization);
    if (!approved.ok) return toolEnvelope({ status: 'not_confirmed', reason: approved.reason });
    d = await ctx.store.discoveryStart(args.keywordConfirmationId, approved.platforms);
  }
  if (!d) return toolEnvelope({ status: 'not_confirmed', reason: 'DISCOVERY_NOT_FOUND' });
  if (d.platforms.some(p => !socialRequest(ctx, p, 'keyword_posts', { keyword: d!.keywords[0] }))) {
    return toolEnvelope({ status: 'not_supported', reason: 'PLATFORM_NOT_VERIFIED' });
  }
  let index = 0;
  let complete = true;
  let stopped = false;
  let stopReason: string | undefined;
  let stopBudget = false;
  const posts = new Map<SocialPlatform, EvidenceItem[]>();
  const found: FoundAccount[] = [];
  let authorCursor = 0;
  let authorLimit = z.number().int().positive().safeParse(d.cursor.authorLimit).data ?? 15;
  for (const platform of d.platforms) {
    const entries: EvidenceItem[] = [];
    posts.set(platform, entries);
    for (const keyword of d.keywords) {
      const request = socialRequest(ctx, platform, 'keyword_posts', { keyword })!;
      const result = await step(ctx, d, budget, index++, request);
      complete &&= result.complete;
      if (result.stopped) {
        stopped = true;
        stopReason = result.reason;
        stopBudget = result.budget === true;
        break;
      }
      entries.push(...result.items.map((item, i) => ({ ...item, ref: `${result.operationId}#${i + 1}` })));
    }
    if (stopped) break;
  }
  if (!stopped) {
    // Rank across platforms, then spend at most the remaining discovery subcall cap on profiles.
    const authors = d.platforms.flatMap(platform => aggregateAuthors(posts.get(platform) ?? [], (posts.get(platform) ?? []).length)
      .map(author => ({ ...author, platform }))).sort((a, b) => b.appearances - a.appearances || b.interactions - a.interactions);
    for (const author of authors.slice(0, authorLimit)) {
      const account = canonicalAccount(author.platform, author.authorId);
      if (!account) continue;
      const request = socialRequest(ctx, author.platform, 'account_profile', { account });
      if (!request) { complete = false; continue; }
      const result = await step(ctx, d, budget, index++, request);
      complete &&= result.complete;
      if (result.stopped) {
        stopped = true;
        stopReason = result.reason;
        stopBudget = result.budget === true;
        break;
      }
      authorCursor += 1;
      const profile = result.items[0];
      if (!profile) continue;
      const metrics = accountMetrics({ profile: { ...profile, ref: `${result.operationId}#1` },
        posts: (posts.get(author.platform) ?? []).filter(p => p.fields.authorId === author.authorId) }, ctx.now());
      found.push({ key: `${author.platform}:${account}`, platform: author.platform, account,
        evidenceRef: `${result.operationId}#1`, metrics,
        classification: classifyAccount(metrics, ctx.config.recentGrowth, ctx.now(), 'discovery') });
    }
    if (!stopped && !selectCandidates(found, true).enough && authorLimit < authors.length) {
      // A later batch only reads old operations and spends this round's allowance on new authors.
      authorLimit = Math.min(authorLimit + 15, authors.length);
      stopped = true;
      stopReason = 'CANDIDATE_SCAN_INCOMPLETE';
    }
  }
  // Reconstruct from stable operations each time; the saved candidates support free follow-up cards.
  await ctx.store.discoverySave(d.discoveryId, { accounts: found, attempted: index, authorCursor, authorLimit }, stopped ? 'running' : 'completed');
  const shown = !stopped && await card(ctx, d.discoveryId, found, false, '');
  const available = selectCandidates(found, true).selectable.length;
  const insufficient = !stopped && complete && !shown;
  const resumable = stopReason === 'ROUND_LIMIT' || stopReason === 'CANDIDATE_SCAN_INCOMPLETE';
  const blockedWithoutData = stopped && !resumable && found.length === 0;
  // A round saved as completed (the same state 0320 counts as a round, partial supplier failures included) without a
  // candidate card: the host may now offer the shortfall choice (0320 decides).
  const shortfall = !stopped && !shown ? await shortfallNotice(ctx) : undefined;
  return toolEnvelope({ ...(shortfall ? { shortfall } : {}), status: blockedWithoutData ? (stopBudget ? 'budget_exhausted' : 'unavailable')
    : complete && shown ? 'ok' : 'partial',
    reason: stopped ? stopReason : shown ? (complete ? null : 'DISCOVERY_PARTIAL')
      : complete ? 'NOT_ENOUGH_CANDIDATES' : 'DISCOVERY_PARTIAL',
    ...(insufficient ? candidateShortage(available) : {}),
    discoveryId: d.discoveryId, continue: stopped && resumable,
    items: found.map(a => ({ fields: { platform: a.platform, account: a.account,
      evidenceRef: a.evidenceRef,
      category: a.classification.excluded === 'ACTIVE_CHECK_PENDING'
        ? 'activity_pending' : a.classification.category ?? 'excluded',
      ...(a.classification.excluded === 'ACTIVE_CHECK_PENDING' ? { activityStatus: '活跃度待核对' } : {}) },
    missing: a.metrics.missing })) });
}

export async function moreCandidates(ctx: ResearchToolContext, discoveryId: string, callId: string) {
  const d = await ctx.store.discoveryRead(discoveryId);
  if (!d) return toolEnvelope({ status: 'not_confirmed', reason: 'DISCOVERY_NOT_FOUND' });
  // A follow-up only replaces accounts picked from a confirmed card; it never stands in for the 8-candidate first card.
  if ((await ctx.store.selectedAccounts(discoveryId)).length === 0) {
    return toolEnvelope({ status: 'not_confirmed', reason: 'NO_CONFIRMED_SELECTION', discoveryId });
  }
  const accounts = (d.cursor.accounts ?? []) as FoundAccount[];
  const shown = await card(ctx, discoveryId, accounts, true, callId);
  const shortfall = shown ? undefined : await shortfallNotice(ctx);
  return toolEnvelope({ status: shown ? 'ok' : 'partial', reason: shown ? null : 'NOT_ENOUGH_CANDIDATES', discoveryId,
    ...(shortfall ? { shortfall } : {}) });
}
