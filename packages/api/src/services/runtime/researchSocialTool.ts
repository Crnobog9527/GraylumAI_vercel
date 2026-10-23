/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT C (plan §2.3.1): the two social lookups a free chat may make. social_search sends one keyword_posts
// subcall per keyword; social_account sends the platform's account route set (profile and posts, Bilibili's relation,
// YouTube's post detail). Neither writes the benchmark table. Each subcall has a stable id from this answer and tool
// call, so a resumed answer reads what it already paid for instead of sending again (and never claims it twice).
import { canonicalAccount, profileLinksIn, type CanonicalAccount } from '../research/tools/accountLinks';
import { statusForOutcome, toolEnvelope, type ToolEnvelope } from '../research/tools/envelope';
import type { ResearchToolArgs } from '../research/tools/schemas';
import { BENCHMARK_ROUTE_KINDS, selectRoute } from '../research/vendors/config';
import type { ResearchItem, SocialKind, SocialPlatform } from '../research/vendors/types';
import { requestIdentity, type SubcallOutcome, type SupplierRequest } from '../research/runtime/subcall';
import { executeResearchCall, stableResearchId, type ResearchToolContext, type ToolAllowance } from '../research/runtime/toolContext';

/** Where a free chat may take an account from: the user's own benchmark table, or the message being answered. */
export interface AccountSources {
  benchmarkAccounts(): Promise<CanonicalAccount[]>;
  /** The body of the user message this answer replies to (never an earlier one). */
  currentMessage(): Promise<string | null>;
}

const DEFAULT_POSTS = 20;
const key = (item: CanonicalAccount) => `${item.platform}:${item.account}`;

function tikhubRequest(ctx: ResearchToolContext, platform: SocialPlatform, kind: SocialKind,
  input: { account?: string; keyword?: string; postId?: string }, limit: number): SupplierRequest | null {
  const route = selectRoute(ctx.config, platform, kind);
  if (!route.ok || route.vendor !== 'tikhub') return null;
  return { vendor: 'tikhub', route: route.route, call: { platform, kind, ...input, limit } };
}

/** A subcall this answer already finished (before a pause or restart): its saved result, never a second request. */
async function saved(ctx: ResearchToolContext, operationId: string, request: SupplierRequest): Promise<SubcallOutcome | 'mismatch' | null> {
  const prior = await ctx.store.readOperation(operationId);
  if (!prior || prior.state === 'prepared') return null;
  if (prior.identityHash !== requestIdentity(request)) return 'mismatch';
  const result = prior.result ?? {};
  const outcome = prior.state === 'succeeded' && (result.outcome === 'ok' || result.outcome === 'partial') ? result.outcome
    : prior.state === 'succeeded' || prior.state === 'failed' ? 'failed' : prior.state === 'cancelled' ? 'not_sent' : 'unknown';
  return { sent: true, operationId, callId: operationId, result: { vendor: 'tikhub', route: request.route, outcome,
    reason: typeof result.reason === 'string' ? result.reason : null, httpStatus: null,
    supplierMayCharge: outcome !== 'not_sent' && result.supplierMayCharge !== false, usage: { unit: 'call', units: null },
    items: Array.isArray(result.items) ? result.items as ResearchItem[] : [], truncated: result.truncated === true,
    fetchedAt: String(result.fetchedAt ?? '') } };
}

type Step = { request: SupplierRequest; operationId: string };
/**
 * Runs the steps in order. Only the unsaved ones need allowance; when none is saved and the allowance cannot cover them
 * all, nothing is sent (all or nothing). A stop after some results returns what came back as `partial`.
 */
async function runSteps(ctx: ResearchToolContext, budget: ToolAllowance, steps: Step[], toolName: string,
  args: Record<string, unknown>, label: (step: Step) => ResearchItem['fields'],
  next?: (step: Step, outcome: Extract<SubcallOutcome, { sent: true }>) => Step | undefined): Promise<string> {
  const known = await Promise.all(steps.map(step => saved(ctx, step.operationId, step.request)));
  if (known.includes('mismatch')) return toolEnvelope({ status: 'unavailable', reason: 'OPERATION_IDENTITY_MISMATCH' });
  if (!known.some(Boolean) && budget.left < steps.length) return toolEnvelope({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
  const items: ToolEnvelope['items'] = [];
  let failed: { status: ToolEnvelope['status']; reason: string | null } | null = null;
  let fetchedAt: string | undefined;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const prior = i < known.length ? known[i] : await saved(ctx, step.operationId, step.request);
    if (prior === 'mismatch') { failed = { status: 'unavailable', reason: 'OPERATION_IDENTITY_MISMATCH' }; break; }
    const outcome = prior ?? await executeResearchCall(ctx, budget, step.request, step.operationId, toolName, args);
    if (!outcome.sent) { failed = { status: outcome.budget ? 'budget_exhausted' : 'unavailable', reason: outcome.stop }; break; }
    const status = statusForOutcome(outcome.result);
    if (status.status !== 'ok' && status.status !== 'partial') { failed = status; break; }
    fetchedAt ??= outcome.result.fetchedAt;
    // Several subcalls share one result, so each item names its own evidence (`<operation>#<n>`) in its fields.
    items.push(...outcome.result.items.map((item, n) => ({ ...(item.url ? { url: item.url } : {}),
      fields: { ...item.fields, ...label(step), ref: `${outcome.operationId}#${n + 1}` }, missing: item.missing })));
    const following = next?.(step, outcome);
    if (following) steps.splice(i + 1, 0, following);
  }
  if (failed && !items.length) return toolEnvelope({ status: failed.status, reason: failed.reason });
  return toolEnvelope({ status: failed ? 'partial' : 'ok', reason: failed?.reason ?? null, items,
    ...(fetchedAt ? { fetchedAt } : {}) });
}

export async function socialSearch(ctx: ResearchToolContext, args: ResearchToolArgs<'social_search'>, budget: ToolAllowance,
  callId: string, raw: Record<string, unknown>): Promise<string> {
  const limit = args.limit ?? DEFAULT_POSTS;
  const steps: Step[] = [];
  for (const [i, keyword] of args.keywords.entries()) {
    const request = tikhubRequest(ctx, args.platform, 'keyword_posts', { keyword }, limit);
    if (!request) return toolEnvelope({ status: 'not_supported', reason: 'ROUTE_NOT_SUPPORTED' });
    steps.push({ request, operationId: stableResearchId(ctx.executionId, callId, 'keyword', String(i)) });
  }
  return runSteps(ctx, budget, steps, 'social_search', raw,
    step => ({ platform: args.platform, keyword: step.request.vendor === 'tikhub' ? step.request.call.keyword ?? '' : '' }));
}

/** The account may come only from the user's benchmark table or a profile link in the message being answered. */
export async function authorizeAccount(sources: AccountSources, platform: SocialPlatform, value: string): Promise<CanonicalAccount | null> {
  const account = canonicalAccount(platform, value);
  if (account === null) return null;
  const wanted = key({ platform, account });
  if ((await sources.benchmarkAccounts()).some(item => key(item) === wanted)) return { platform, account };
  const message = await sources.currentMessage();
  return message !== null && profileLinksIn(message).some(item => key(item) === wanted) ? { platform, account } : null;
}

export async function socialAccount(ctx: ResearchToolContext, args: ResearchToolArgs<'social_account'>, budget: ToolAllowance,
  callId: string, raw: Record<string, unknown>, sources: AccountSources): Promise<string> {
  const allowed = await authorizeAccount(sources, args.platform, args.account);
  if (!allowed) return toolEnvelope({ status: 'not_confirmed', reason: 'ACCOUNT_NOT_CONFIRMED' });
  const kinds = BENCHMARK_ROUTE_KINDS[args.platform]?.kinds;
  const limit = args.posts ?? DEFAULT_POSTS;
  const step = (kind: SocialKind, postId?: string): Step | null => {
    const request = tikhubRequest(ctx, args.platform, kind, { account: allowed.account, ...(postId ? { postId } : {}) }, limit);
    return request && { request, operationId: stableResearchId(ctx.executionId, callId, kind) };
  };
  // post_detail needs a post id from account_posts, so it is added once those came back (YouTube).
  const first = kinds?.filter(kind => kind !== 'post_detail').map(kind => step(kind));
  if (!kinds || !first?.length || first.some(item => !item) || kinds.includes('post_detail') && !step('post_detail', 'x')) {
    return toolEnvelope({ status: 'not_supported', reason: 'ROUTE_NOT_SUPPORTED' });
  }
  const steps = first as Step[];
  // Allowance covers the whole set up front, post detail included.
  if (kinds.includes('post_detail') && budget.left < kinds.length && !(await saved(ctx, steps[0]!.operationId, steps[0]!.request))) {
    return toolEnvelope({ status: 'budget_exhausted', reason: 'ROUND_LIMIT' });
  }
  return runSteps(ctx, budget, steps, 'social_account', raw,
    item => ({ platform: args.platform, account: allowed.account,
      dataKind: item.request.vendor === 'tikhub' ? item.request.call.kind : '' }),
    (current, outcome) => {
      if (!kinds.includes('post_detail') || current.request.vendor !== 'tikhub' || current.request.call.kind !== 'account_posts') return undefined;
      const postId = outcome.result.items[0]?.fields.id;
      return typeof postId === 'string' ? step('post_detail', postId) ?? undefined : undefined;
    });
}
