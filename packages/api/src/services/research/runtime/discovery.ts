/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { aggregateAuthors, classifyAccount, selectCandidates, type ScoredAccount } from '../benchmark/classify';
import { accountMetrics, type EvidenceItem } from '../benchmark/metrics';
import { BENCHMARK_ROUTE_KINDS, BENCHMARK_RULES } from '../vendors/config';
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
import { deepen, discoveryCap, discoveryCoverage, total, type PlatformCoverage } from './discoveryLayers';

const itemSchema = z.object({ url: z.string().optional(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  missing: z.array(z.string()) });
interface FoundAccount extends ScoredAccount { platform: SocialPlatform; account: string; evidenceRef: string; name?: string }
interface StepResult {
  items: ResearchItem[]; operationId: string; complete: boolean; stopped: boolean;
  reason?: string; budget?: boolean;
  /** A keyword search's next page (BENCHMARK-COVERAGE), from the answer or the saved operation. */
  nextCursor?: string;
}

const CARD_SHOWN_NEXT_STEP = '候选卡已经显示给用户：请用户在卡上勾选并确认，确认后再取数。不要说没有候选卡。';

/** The supplier's display name for a card label: one line, no control characters, never longer than 30 characters. */
export function accountName(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 30).join('').trimEnd();
    if (name) return name;
  }
  return undefined;
}

/**
 * The paid lookup that screens one author: the account profile where the platform's benchmark routes have one, otherwise
 * the route its followers come from. YouTube has no profile route; it reads the detail of one of the author's own videos
 * found by this search (the channel's subscriber label, BENCHMARK-COVERAGE #1290).
 */
function authorLookup(ctx: ResearchToolContext, platform: SocialPlatform, account: string, authorPosts: EvidenceItem[]) {
  const routes = BENCHMARK_ROUTE_KINDS[platform];
  if (!routes || routes.kinds.includes('account_profile')) return socialRequest(ctx, platform, 'account_profile', { account });
  if (routes.followersFrom !== 'post_detail') return socialRequest(ctx, platform, routes.followersFrom, { account });
  const postId = authorPosts.map(post => post.fields.id).find((id): id is string => typeof id === 'string');
  return postId ? socialRequest(ctx, platform, 'post_detail', { account, postId }) : null;
}

/** A round searched to the end with fewer selectable accounts than a candidate card needs: no card (plan §1.2 step 5). */
export function candidateShortage(available: number) {
  const required = BENCHMARK_RULES.candidatesMin;
  return {
    message: `这一轮已经搜完：找到 ${available} 个可选、需要 ${required} 个才能出候选卡。`,
    nextStep: '告诉用户两条出路：换一组关键词再搜一轮，或直接发来想对标的账号主页链接（按链接取数核对，'
      + '核对合格的账号同样算对标）。搜过两轮仍不够时，主要建议发链接，不要只让用户再搜。',
    availableCandidates: available,
    requiredCandidates: required,
  };
}

/** A round stopped before its end (this reply's lookups ran out): it is not a round yet and continues on the next reply. */
export const ROUND_UNFINISHED_NEXT_STEP = '这一轮搜索还没搜完，不算一轮。用一句话告诉用户正在扩大搜索、会自动接着搜'
  + '（没有自动继续时回复"继续"即可）；已经取过的数据不会重复取、不重复收费。不要说已经搜完，也不要建议换关键词。';

/** Authors whose profiles one scan batch reads; the first batch is read whole so the card can show up to 12. */
const AUTHOR_BATCH = 15;

/** The operation is the durable cursor. A crash after dispatch never causes another supplier request. */
async function step(ctx: ResearchToolContext, d: DiscoveryRecord, budget: ToolAllowance,
  index: number, request: SupplierRequest): Promise<StepResult> {
  let operationId = stableResearchId(d.discoveryId, String(index));
  let prior = await ctx.store.readOperation(operationId);
  // A prior answer's unsent plan cannot be rebound to this answer's billing run. Cancel under the
  // existing plan lock, verify it really stayed unsent, then contend for one stable successor id.
  for (let recovery = 0; recovery < 20; recovery += 1) {
    // readOperation already validates the original plan/link and recovers its receipt before returning
    // a result. Only prepared, cancelled or missing operations need the unsent-plan recovery below.
    if (prior && prior.state !== 'prepared' && prior.state !== 'cancelled') break;
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
    const saved = prior.result?.nextCursor;
    return { operationId, items: parsed.success ? parsed.data : [],
      complete: prior.state === 'succeeded' && parsed.success, stopped: false,
      ...(typeof saved === 'string' ? { nextCursor: saved } : {}) };
  }
  if (budget.left === 0) return { operationId, items: [], complete: false, stopped: true, reason: 'ROUND_LIMIT', budget: true };
  const outcome = await executeResearchCall(ctx, budget, request, operationId, 'benchmark_discover',
    { discoveryId: d.discoveryId }, d.discoveryId);
  return { operationId, items: outcome.sent ? outcome.result.items : [],
    complete: outcome.sent && ['ok', 'partial'].includes(outcome.result.outcome), stopped: !outcome.sent,
    ...(outcome.sent && outcome.result.nextCursor ? { nextCursor: outcome.result.nextCursor } : {}),
    ...(!outcome.sent ? { reason: outcome.stop, budget: outcome.budget } : {}) };
}

/** Shows the card and returns how many options on it the user can tick (0: no card shown). */
async function card(ctx: ResearchToolContext, discoveryId: string, accounts: FoundAccount[], followUp: boolean, callId: string) {
  const chosen = followUp ? await ctx.store.selectedAccounts(discoveryId) : [];
  const keys = new Set(chosen.map(a => `${a.platform}:${a.account}`));
  const remaining = accounts.filter(a => !keys.has(a.key));
  const selection = selectCandidates(remaining, true);
  if ((!followUp && !selection.enough) || selection.selectable.length === 0) return 0;
  const selectable = new Set(selection.selectable.map(a => a.key));
  const references = !followUp ? selection.headReferences.slice(0, 3) : [];
  const ordered = [...selection.selectable.slice(0, 12 - references.length), ...references] as FoundAccount[];
  const options: ResearchCandidateOption[] = ordered
    .map((a, i) => ({ id: `c${i}`, platform: a.platform, account: a.account, evidenceRef: a.evidenceRef,
      // The account id stays on the card's second line; the label leads with the readable name.
      label: a.classification.excluded === 'ACTIVE_CHECK_PENDING'
        ? `${a.name ?? a.account} · 活跃度待核对` : a.name ?? a.account,
      selectable: selectable.has(a.key) }));
  const payload = { kind: 'candidates' as const, discoveryId, options: options.map(o => ({ ...o })),
    ...(followUp ? { followUp: true, minSelect: Math.min(options.length, Math.max(1, 3 - keys.size)) } : {}) };
  const cardId = stableResearchId(discoveryId, followUp ? callId : 'first-card');
  const saved = await ctx.store.readCard(cardId) ?? await ctx.store.createCard(cardId, payload);
  const savedOptions = saved.options as unknown as ResearchCandidateOption[];
  ctx.emit({ type: 'research_card', card: { ...saved, kind: 'candidates', options: savedOptions,
    ...(followUp ? { followUp: true } : {}) } });
  // Count what was emitted: head references take slots and a reused saved card may differ from this rebuild.
  return savedOptions.filter(option => option.selectable).length;
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
  let authorLimit = z.number().int().positive().safeParse(d.cursor.authorLimit).data ?? AUTHOR_BATCH;
  const coverage = discoveryCoverage(d.platforms, d.keywords.length);
  // Every paid step of this discovery goes through here, in a fixed order, so a resumed call replays the same ids.
  const pay = async (platform: SocialPlatform, request: SupplierRequest, kind: keyof PlatformCoverage['spent']) => {
    const spent = coverage.platforms[platform]!;
    if (total(spent) >= discoveryCap(platform, d.platforms.length)) { spent.capReached = true; return null; }
    const result = await step(ctx, d, budget, index++, request);
    // Counted only when dispatched now or replayed from a saved operation: a step stopped before sending never happened.
    if (!result.stopped) spent.spent[kind] += 1;
    complete &&= result.complete;
    if (result.stopped) {
      stopped = true;
      stopReason = result.reason;
      stopBudget = result.budget === true;
    }
    return result;
  };
  const screened = new Set<string>();
  const enough = () => selectCandidates(found, true).enough;
  /** One paid lookup that screens an author (or an account-search lead); each account at most once. */
  const screen = async (platform: SocialPlatform, authorId: string, label: string | null, authorPosts: EvidenceItem[]) => {
    const account = canonicalAccount(platform, authorId);
    if (!account || screened.has(`${platform}:${account}`)) return;
    const request = authorLookup(ctx, platform, account, authorPosts);
    if (!request) { complete = false; return; }
    const result = await pay(platform, request, 'profiles');
    if (!result || result.stopped) return;
    screened.add(`${platform}:${account}`);
    authorCursor += 1;
    const profile = result.items[0];
    // A video detail speaks for its own channel only: a different channel's numbers never screen this author.
    if (!profile || (request.vendor === 'tikhub' && request.call.kind === 'post_detail'
      && profile.fields.authorId !== authorId)) return;
    const metrics = accountMetrics({ profile: { ...profile, ref: `${result.operationId}#1` }, posts: authorPosts }, ctx.now());
    const name = accountName(profile.fields.name, label);
    found.push({ key: `${platform}:${account}`, platform, account, ...(name ? { name } : {}),
      evidenceRef: `${result.operationId}#1`, metrics,
      classification: classifyAccount(metrics, ctx.config.recentGrowth, ctx.now(), 'discovery') });
  };
  const firstPages = new Map<string, { cursor?: string; fresh: number }>();
  for (const platform of d.platforms) {
    const entries: EvidenceItem[] = [];
    posts.set(platform, entries);
    for (const keyword of d.keywords) {
      const seen = new Set(entries.map(post => post.fields.authorId));
      const result = await pay(platform, socialRequest(ctx, platform, 'keyword_posts', { keyword })!, 'searches');
      if (!result || stopped) break;
      const page = result.items.map((item, i) => ({ ...item, ref: `${result.operationId}#${i + 1}` }));
      entries.push(...page);
      firstPages.set(`${platform}\n${keyword}`, { cursor: result.nextCursor,
        fresh: new Set(page.map(post => post.fields.authorId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0 && !seen.has(id))).size });
    }
    if (stopped) break;
  }
  if (!stopped) {
    // Rank across platforms, then spend at most the remaining discovery subcall cap on profiles.
    const authors = d.platforms.flatMap(platform => aggregateAuthors(posts.get(platform) ?? [], (posts.get(platform) ?? []).length)
      .map(author => ({ ...author, platform }))).sort((a, b) => b.appearances - a.appearances || b.interactions - a.interactions);
    let scanned = 0;
    // Too few candidates in this batch: widen the scan within this call's own allowance (a stop at the allowance saves the
    // wider limit; the next reply re-reads paid operations and continues), so a reply never ends a round early by itself.
    while (!stopped) {
      for (const [offset, author] of authors.slice(scanned, authorLimit).entries()) {
        // Past the first batch, the eighth selectable account ends the scan: no further profile is paid for.
        if (scanned + offset >= AUTHOR_BATCH && enough()) break;
        await screen(author.platform, author.authorId, author.author,
          (posts.get(author.platform) ?? []).filter(p => p.fields.authorId === author.authorId));
        if (stopped) break;
      }
      scanned = authorLimit;
      if (stopped || enough() || authorLimit >= authors.length) break;
      authorLimit = Math.min(authorLimit + AUTHOR_BATCH, authors.length);
    }
  }
  // BENCHMARK-COVERAGE: still short of a card after every first-page author, search deeper before calling it a shortfall.
  // Deeper layers stop at a full card (candidatesMax, plan §3 item 1); a card still shows from candidatesMin.
  const full = () => selectCandidates(found, true).selectable.length >= BENCHMARK_RULES.candidatesMax;
  if (!stopped && !full()) {
    await deepen({ ctx, d, posts, firstPages, coverage, pay, screen, enough: full, isStopped: () => stopped });
  }
  // Reconstruct from stable operations each time; the saved candidates support free follow-up cards.
  await ctx.store.discoverySave(d.discoveryId, { accounts: found, attempted: index, authorCursor, authorLimit }, stopped ? 'running' : 'completed');
  const onCard = stopped ? 0 : await card(ctx, d.discoveryId, found, false, '');
  const shown = onCard > 0;
  const available = selectCandidates(found, true).selectable.length;
  const insufficient = !stopped && !shown;
  const resumable = stopReason === 'ROUND_LIMIT';
  const blockedWithoutData = stopped && !resumable && found.length === 0;
  // A round saved as completed (the same state 0320 counts as a round, partial supplier failures included) without a
  // candidate card: the host may now offer the shortfall choice (0320 decides).
  const shortfall = !stopped && !shown ? await shortfallNotice(ctx) : undefined;
  // The round goes on in the next reply: tell the page (it continues on the user's behalf, plan §4.2 / PR-7).
  if (stopped && resumable) ctx.emit({ type: 'research_continue', discoveryId: d.discoveryId });
  return toolEnvelope({ ...(shortfall ? { shortfall } : {}), status: blockedWithoutData ? (stopBudget ? 'budget_exhausted' : 'unavailable')
    : complete && shown ? 'ok' : 'partial',
    reason: stopped ? stopReason : shown ? (complete ? null : 'DISCOVERY_PARTIAL')
      : complete ? 'NOT_ENOUGH_CANDIDATES' : 'DISCOVERY_PARTIAL',
    ...(insufficient ? candidateShortage(available) : {}),
    // The host shows the card, not the model's text: say so, or the model may deny a card the user can see.
    ...(shown ? { candidateCard: { shown: true, selectable: onCard }, nextStep: CARD_SHOWN_NEXT_STEP }
      : { candidateCard: { shown: false } }),
    ...(stopped && resumable ? { nextStep: ROUND_UNFINISHED_NEXT_STEP } : {}),
    // What this round searched (code-counted): the coach says this, never its own guess at the coverage.
    coverage,
    discoveryId: d.discoveryId, continue: stopped && resumable,
    items: found.map(a => ({ fields: { platform: a.platform, account: a.account, ...(a.name ? { name: a.name } : {}),
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
  const onCard = await card(ctx, discoveryId, accounts, true, callId);
  const shown = onCard > 0;
  const shortfall = shown ? undefined : await shortfallNotice(ctx);
  return toolEnvelope({ status: shown ? 'ok' : 'partial', reason: shown ? null : 'NOT_ENOUGH_CANDIDATES', discoveryId,
    candidateCard: shown ? { shown, selectable: onCard } : { shown }, ...(shown ? { nextStep: CARD_SHOWN_NEXT_STEP } : {}),
    ...(shortfall ? { shortfall } : {}) });
}
