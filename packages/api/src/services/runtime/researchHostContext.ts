/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-6: what the positioning mentor needs to continue the benchmark flow across replies. Tool results
// do not stay in the conversation history, so the host hands the model this session's selection cards (with the
// confirmation ids the tools require) and the host benchmark table as trusted turn context. Read only: nothing here
// sends a supplier request or charges; every id is checked again by the tool that uses it (0263).
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SettingsRead } from './newWorkGate';
import { logger } from '../../lib/logger';
import { SOCIAL_PLATFORMS } from '../research/vendors/types';
import { benchmarkReportFacts } from '../report/contract';
import { HOST_TURN_MAX_BYTES, RESEARCH_CARDS_NOTE, RESEARCH_SHORTFALL_NOTE, researchContextSchema, type HostTurnContext } from './hostTurn';

type Research = NonNullable<HostTurnContext['research']>;
/** The product rule (Master Plan 3.7, R11): a positioning report needs at least this many qualified benchmarks. */
export const POSITIONING_QUALIFIED_BENCHMARKS = 3;
const MAX_CARDS = 3;
const MAX_ROWS = 12;

const card = z.object({ cardId: z.string().uuid(), kind: z.enum(['keywords', 'candidates']), confirmationId: z.string().uuid().nullable(),
  items: z.array(z.unknown()).nullable() }).passthrough();
const account = z.object({ platform: z.enum(SOCIAL_PLATFORMS), account: z.string() }).passthrough();
const row = z.object({ platform: z.enum(SOCIAL_PLATFORMS), account: z.string(),
  category: z.enum(['head_reference', 'imitable', 'fast_rising']).nullable(), qualified: z.boolean(),
  excluded: z.string().nullable(), followers: z.number().nullable(), medianViews: z.number().nullable(),
  engagementRate: z.number().nullable(), lastPublishedAt: z.string().nullable() }).passthrough();

const shortfallRead = z.object({ rounds: z.number().int().min(0), qualified: z.number().int().min(0),
  card: z.object({ cardId: z.string().uuid(), choice: z.enum(['continue', 'generate']).nullable(),
    chosenQualified: z.number().int().min(0).nullable(), chosenRounds: z.number().int().nullable() }).passthrough().nullable() }).passthrough();

/** BENCHMARK-SHORTFALL (0318): the session's completed searches and its newest choice card, for the coach. */
export function shortfallContext(value: z.infer<typeof shortfallRead>) {
  const { rounds, card } = value;
  return { note: RESEARCH_SHORTFALL_NOTE, rounds: Math.min(rounds, 1000),
    card: card ? { cardId: card.cardId, choice: card.choice, qualifiedAtChoice: card.chosenQualified } : null };
}

async function read(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await admin.rpc(name, args);
  if (result.error) throw new Error('OPC_RESEARCH_UNAVAILABLE');
  return result.data;
}

/** Read only; a read failure leaves it out: without the ids the tools refuse (not_confirmed), so nothing is sent or charged. */
export async function researchHostContext(admin: SupabaseClient, actorId: string, sessionId: string): Promise<Research | undefined> {
  try {
    const cards = z.array(card).parse(await read(admin, 'research_user_cards', { a: actorId, s: sessionId })).slice(-MAX_CARDS);
    const out: Research['cards'] = [];
    for (const item of cards) {
      const confirmed = item.confirmationId !== null && item.items !== null;
      if (item.kind === 'keywords') {
        out.push({ kind: 'keywords', cardId: item.cardId, confirmationId: item.confirmationId,
          keywords: confirmed ? z.array(z.string()).parse(item.items) : [] });
        continue;
      }
      const discovery = confirmed ? z.object({ discoveryId: z.string().uuid().nullable() }).passthrough().nullable()
        .parse(await read(admin, 'research_confirmation_read', { a: actorId, s: sessionId, p_confirmation: item.confirmationId })) : null;
      out.push({ kind: 'candidates', cardId: item.cardId, confirmationId: item.confirmationId, discoveryId: discovery?.discoveryId ?? null,
        accounts: confirmed ? z.array(account).parse(item.items).map(a => ({ platform: a.platform, account: a.account })) : [] });
    }
    const table = benchmarkReportFacts(await read(admin, 'research_benchmark_rows', { a: actorId, s: sessionId }));
    const rows = table.serialized ? z.array(row).parse(JSON.parse(table.serialized)) : [];
    const qualified = new Set(rows.filter(r => r.qualified).map(r => `${r.platform}:${r.account}`)).size;
    // Qualified rows first, so a cut keeps what counts toward the report.
    const shown = [...rows.filter(r => r.qualified), ...rows.filter(r => !r.qualified)].slice(0, MAX_ROWS).map(r => ({
      platform: r.platform, account: r.account, category: r.category, qualified: r.qualified, excluded: r.excluded,
      followers: r.followers, medianViews: r.medianViews, engagementRate: r.engagementRate, lastPublishedAt: r.lastPublishedAt }));
    // Before 0318 the function does not exist: the turn goes on without the shortfall block, as before.
    const shortfall = await admin.rpc('research_user_shortfall', { a: actorId, s: sessionId }).then(r => r, () => null);
    const parsed = !shortfall || shortfall.error ? null : shortfallRead.safeParse(shortfall.data);
    return researchContextSchema.parse({ note: RESEARCH_CARDS_NOTE, cards: out,
      benchmarks: { required: POSITIONING_QUALIFIED_BENCHMARKS, qualified, rows: shown },
      ...(parsed?.success ? { shortfall: shortfallContext(parsed.data) } : {}) });
  } catch (error) {
    logger.warn('api', 'OPC research context unavailable', { error: error instanceof Error ? error.message : 'unknown' });
    return undefined;
  }
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Adds the research context within the host context ceiling: unqualified rows go first, then the oldest cards. */
export function withResearchContext(context: HostTurnContext, research: Research | undefined): HostTurnContext {
  if (!research) return context;
  const next = { ...research, cards: [...research.cards], benchmarks: { ...research.benchmarks, rows: [...research.benchmarks.rows] } };
  const fits = () => bytes({ ...context, research: next }) <= HOST_TURN_MAX_BYTES;
  while (!fits() && next.benchmarks.rows.some(r => !r.qualified)) {
    next.benchmarks.rows.splice(next.benchmarks.rows.findLastIndex(r => !r.qualified), 1);
  }
  while (!fits() && next.cards.length) next.cards.shift();
  while (!fits() && next.benchmarks.rows.length) next.benchmarks.rows.pop();
  return fits() ? { ...context, research: next } : context;
}

/**
 * Admission: only a non-opening, non-summary mentor turn with the research switch on (read in admission's one settings
 * query, so a switched-off turn costs no extra round trip) gets the block; it is then sized like the rest of the turn.
 */
/** `actorId` is the identity admission already verified; no second authentication happens here. */
export async function researchHost(context: HostTurnContext, admin: SupabaseClient, actorId: string, sessionId: string,
  read: Promise<SettingsRead> | null): Promise<HostTurnContext> {
  if (!read || context.opening || context.stepSummary) return context;
  const settings = await read;
  if (!settings.ok || settings.researchEnabled !== true) return context;
  return withResearchContext(context, await researchHostContext(admin, actorId, sessionId));
}
