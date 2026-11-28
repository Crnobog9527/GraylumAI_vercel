/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Owner 2026-11-28 (H): what a fetched account's relevance is judged by, saved with its evidence so a refresh judges it the same way
// (review of #2063). A candidate is judged against the keywords of the search round that found it, not the session's other rounds;
// an account the user sent the link of is the user's own pick and is judged on its numbers only, also when it is refreshed.
import { z } from 'zod';
import type { ResearchToolArgs } from '../tools/schemas';
import type { RuntimeResearchStore } from '../runtime/store';
import type { SocialPlatform } from '../vendors/types';

export type RelevanceBasis = { kind: 'keywords'; keywords: string[] } | { kind: 'user_pick' }
  /** Fetched before relevance was judged: a refresh does not start judging what the user already had (never newly disqualified). */
  | { kind: 'unjudged' };

const saved = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keywords'), keywords: z.array(z.string().max(40)).max(40) }),
  z.object({ kind: z.literal('user_pick') }), z.object({ kind: z.literal('unjudged') }),
]);

/** The basis of one account of this call: a refresh keeps the saved one (computed before the refresh claims the fetch). */
export async function relevanceBasis(store: RuntimeResearchStore, source: ResearchToolArgs<'benchmark_fetch'>['source'],
  account: { platform: SocialPlatform; account: string }, roundKeywords: () => Promise<string[]>): Promise<RelevanceBasis> {
  if (source.kind === 'user_message') return { kind: 'user_pick' };
  if (source.kind === 'candidate') return { kind: 'keywords', keywords: await roundKeywords() };
  const prior = await store.priorEvidence?.(account.platform, account.account).catch(() => null) ?? null;
  const parsed = saved.safeParse(prior?.relevanceBasis);
  return parsed.success ? parsed.data : { kind: 'unjudged' };
}

/** The keywords the account is judged by, or none (a user pick or an account fetched before the rule: not judged). */
export const judgedKeywords = (basis: RelevanceBasis): string[] => basis.kind === 'keywords' ? basis.keywords : [];
