/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { ResearchTurnEvent } from '../../../shared/researchTurn';
import type { AuthorizationScope } from '../tools/authorize';
import type { ResearchToolsConfig } from '../vendors/config';
import { selectRoute } from '../vendors/config';
import type { SocialKind, SocialPlatform } from '../vendors/types';
import { runSubcall, type SubcallContext, type SubcallOutcome, type SupplierRequest } from './subcall';
import type { RuntimeResearchStore } from './store';

export interface ResearchToolContext {
  scope: AuthorizationScope;
  executionId: string;
  config: ResearchToolsConfig;
  store: RuntimeResearchStore;
  subcall: SubcallContext;
  emit: (event: ResearchTurnEvent) => void;
  now: () => Date;
  /** false = too little of this reply's time is left for another paid lookup and the reply after it (missing: no limit). */
  lookupTime?: () => boolean;
}
/** Stable across a resumed discovery; different users/discoveries never share evidence. */
export function stableResearchId(...parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function socialRequest(ctx: ResearchToolContext, platform: SocialPlatform, kind: SocialKind,
  input: { account?: string; keyword?: string; postId?: string; cursor?: string }): SupplierRequest | null {
  const route = selectRoute(ctx.config, platform, kind, 'benchmark');
  if (!route.ok || route.vendor !== 'tikhub') return null;
  return { vendor: 'tikhub', route: route.route, call: { platform, kind, ...input, limit: 30 } };
}

export interface ToolAllowance { left: number; used: number }
/** What one subcall asked for, as the `research_call` event shows it. */
export const callDisplay = (request: SupplierRequest) => request.vendor === 'tikhub'
  ? { query: request.call.keyword ?? request.call.account ?? request.call.postId ?? '',
    platform: request.call.platform, dataKind: request.call.kind }
  : request.vendor === 'parallel' ? { query: request.query, platform: 'web' as const, dataKind: 'web_search' as const }
    : { query: request.url, platform: 'web' as const, dataKind: 'web_fetch' as const };
/** Reserve this round's allowance before any await; tools and subcalls execute serially. */
export async function executeResearchCall(ctx: ResearchToolContext, budget: ToolAllowance, request: SupplierRequest,
  operationId: string, toolName: string, args: Record<string, unknown>, discoveryId?: string): Promise<SubcallOutcome> {
  if (budget.left <= 0) return { sent: false, budget: true, stop: 'VENDOR_RATE_LIMITED' };
  budget.left -= 1;
  budget.used += 1;
  const display = callDisplay(request);
  ctx.emit({ type: 'research_call', callId: operationId, toolName, args, ...display, state: 'running' });
  // Each subcall saves what it actually asked for, so charges and evidence rows describe it exactly.
  const outcome = await runSubcall({ ...ctx.subcall, newId: () => operationId,
    evidence: ctx.store.evidence(discoveryId), metadata: { toolName, args, call: display } }, request);
  // The user's own settled credits for this subcall; a read failure only hides the amount (null).
  const credits = outcome.sent ? await ctx.store.callCharge(outcome.callId).catch(() => null) : undefined;
  ctx.emit({ type: 'research_call', callId: operationId, toolName, args, ...display,
    state: outcome.sent ? (outcome.result.outcome === 'unknown' ? 'unknown'
      : ['ok', 'partial'].includes(outcome.result.outcome) ? 'succeeded' : 'failed') : 'failed',
    ...(outcome.sent ? { evidenceId: outcome.operationId, credits } : {}) });
  return outcome;
}
