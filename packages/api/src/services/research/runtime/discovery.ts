/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { aggregateAuthors, classifyAccount, selectCandidates, type ScoredAccount } from '../benchmark/classify';
import { accountMetrics, type EvidenceItem } from '../benchmark/metrics';
import { authorizeDiscoverStart } from '../tools/authorize';
import { canonicalAccount } from '../tools/accountLinks';
import { toolEnvelope } from '../tools/envelope';
import type { ResearchToolArgs } from '../tools/schemas';
import type { ResearchCandidateOption } from '../../../shared/researchTurn';
import type { ResearchItem, SocialPlatform } from '../vendors/types';
import { executeResearchCall, socialRequest, stableResearchId, type ResearchToolContext, type ToolAllowance } from './toolContext';
import type { DiscoveryRecord } from './store';
import type { SupplierRequest } from './subcall';

const itemSchema = z.object({ url: z.string().optional(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  missing: z.array(z.string()) });
interface FoundAccount extends ScoredAccount { platform: SocialPlatform; account: string; evidenceRef: string }
interface StepResult { items: ResearchItem[]; operationId: string; complete: boolean; stopped: boolean }

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
        return { operationId, items: [], complete: false, stopped: true };
      }
    }
    if (prior?.state !== 'cancelled' && !(plan?.cancelled && !prior)) break;
    operationId = stableResearchId(operationId, 'unsent-successor');
    prior = await ctx.store.readOperation(operationId);
    if (recovery === 19) return { operationId, items: [], complete: false, stopped: true };
  }
  if (prior && prior.state !== 'prepared') {
    const parsed = z.array(itemSchema).safeParse(prior.result?.items);
    return { operationId, items: parsed.success ? parsed.data : [],
      complete: prior.state === 'succeeded' && parsed.success, stopped: false };
  }
  if (budget.left === 0) return { operationId, items: [], complete: false, stopped: true };
  const outcome = await executeResearchCall(ctx, budget, request, operationId, 'benchmark_discover',
    { discoveryId: d.discoveryId }, d.discoveryId);
  return { operationId, items: outcome.sent ? outcome.result.items : [],
    complete: outcome.sent && ['ok', 'partial'].includes(outcome.result.outcome), stopped: !outcome.sent };
}

async function card(ctx: ResearchToolContext, discoveryId: string, accounts: FoundAccount[], followUp: boolean, callId: string) {
  const chosen = followUp ? await ctx.store.selectedAccounts(discoveryId) : [];
  const keys = new Set(chosen.map(a => `${a.platform}:${a.account}`));
  const remaining = accounts.filter(a => !keys.has(a.key));
  const selection = selectCandidates(remaining);
  if ((!followUp && !selection.enough) || selection.selectable.length === 0) return false;
  const selectable = new Set(selection.selectable.map(a => a.key));
  const ordered = [...selection.selectable, ...(!followUp ? selection.headReferences.slice(0, 3) : [])] as FoundAccount[];
  const options: ResearchCandidateOption[] = ordered
    .map((a, i) => ({ id: `c${i}`, platform: a.platform, account: a.account, evidenceRef: a.evidenceRef,
      label: a.account, selectable: selectable.has(a.key) }));
  const payload = { kind: 'candidates' as const, discoveryId, options: options.map(o => ({ ...o })),
    ...(followUp ? { followUp: true, minSelect: Math.min(options.length, Math.max(1, 3 - keys.size)) } : {}) };
  const saved = await ctx.store.createCard(stableResearchId(discoveryId, followUp ? callId : 'first-card'), payload);
  ctx.emit({ type: 'research_card', card: { ...saved, kind: 'candidates', options, ...(followUp ? { followUp: true } : {}) } });
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
  const cap = ctx.config.limits.discoverSubcalls;
  let index = 0;
  let complete = true;
  let stopped = false;
  const posts = new Map<SocialPlatform, EvidenceItem[]>();
  const found: FoundAccount[] = [];
  for (const platform of d.platforms) {
    const entries: EvidenceItem[] = [];
    posts.set(platform, entries);
    for (const keyword of d.keywords) {
      if (index >= cap) { complete = false; break; }
      const request = socialRequest(ctx, platform, 'keyword_posts', { keyword })!;
      const result = await step(ctx, d, budget, index++, request);
      complete &&= result.complete;
      if (result.stopped) { stopped = true; break; }
      entries.push(...result.items.map((item, i) => ({ ...item, ref: `${result.operationId}#${i + 1}` })));
    }
    if (stopped) break;
  }
  if (!stopped) {
    // Rank across platforms, then spend at most the remaining discovery subcall cap on profiles.
    const authors = d.platforms.flatMap(platform => aggregateAuthors(posts.get(platform) ?? [], 15)
      .map(author => ({ ...author, platform }))).sort((a, b) => b.appearances - a.appearances || b.interactions - a.interactions);
    for (const author of authors.slice(0, Math.min(15, Math.max(0, cap - index)))) {
      const account = canonicalAccount(author.platform, author.authorId);
      if (!account) continue;
      const request = socialRequest(ctx, author.platform, 'account_profile', { account });
      if (!request) { complete = false; continue; }
      const result = await step(ctx, d, budget, index++, request);
      complete &&= result.complete;
      if (result.stopped) { stopped = true; break; }
      const profile = result.items[0];
      if (!profile) continue;
      const metrics = accountMetrics({ profile: { ...profile, ref: `${result.operationId}#1` },
        posts: (posts.get(author.platform) ?? []).filter(p => p.fields.authorId === author.authorId) }, ctx.now());
      found.push({ key: `${author.platform}:${account}`, platform: author.platform, account,
        evidenceRef: `${result.operationId}#1`, metrics, classification: classifyAccount(metrics, ctx.config.recentGrowth, ctx.now()) });
    }
  }
  // Reconstruct from stable operations each time; the saved candidates support free follow-up cards.
  await ctx.store.discoverySave(d.discoveryId, { accounts: found, attempted: index }, stopped ? 'running' : 'completed');
  const shown = !stopped && await card(ctx, d.discoveryId, found, false, '');
  return toolEnvelope({ status: complete && shown ? 'ok' : 'partial',
    reason: stopped ? 'ROUND_LIMIT' : shown ? (complete ? null : 'DISCOVERY_PARTIAL') : 'NOT_ENOUGH_CANDIDATES',
    discoveryId: d.discoveryId, continue: stopped,
    items: found.map(a => ({ fields: { platform: a.platform, account: a.account,
      evidenceRef: a.evidenceRef, category: a.classification.category ?? 'excluded' }, missing: a.metrics.missing })) });
}

export async function moreCandidates(ctx: ResearchToolContext, discoveryId: string, callId: string) {
  const d = await ctx.store.discoveryRead(discoveryId);
  if (!d) return toolEnvelope({ status: 'not_confirmed', reason: 'DISCOVERY_NOT_FOUND' });
  const accounts = (d.cursor.accounts ?? []) as FoundAccount[];
  const shown = await card(ctx, discoveryId, accounts, true, callId);
  return toolEnvelope({ status: shown ? 'ok' : 'partial', reason: shown ? null : 'NOT_ENOUGH_CANDIDATES', discoveryId });
}
