/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-6: what the positioning mentor needs to continue the benchmark flow across replies. Tool results
// do not stay in the conversation history, so the host hands the model this session's selection cards (with the
// confirmation ids the tools require) and the host benchmark table as trusted turn context. Read only: nothing here
// sends a supplier request or charges; every id is checked again by the tool that uses it (0263).
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { readResearchToolsConfig } from '../research/vendors/config';
import { SOCIAL_PLATFORMS } from '../research/vendors/types';
import { benchmarkReportFacts } from '../report/contract';
import { researchRefreshContext, withResearchRefresh } from './researchRefresh';
import { HOST_TURN_MAX_BYTES, RESEARCH_CARDS_NOTE, researchContextSchema, type HostTurnContext } from '../runtime/hostTurn';

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

async function read(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await admin.rpc(name, args);
  if (result.error) throw new Error('OPC_RESEARCH_UNAVAILABLE');
  return result.data;
}

/**
 * Only a non-opening mentor answer with the research switch on gets it. A read failure leaves it out instead of
 * blocking the conversation: without the ids the tools refuse (not_confirmed), so nothing is sent or charged.
 */
export async function researchHostContext(admin: SupabaseClient, actorId: string, sessionId: string,
  turn: { purpose: string; opening: boolean; stepSummary: boolean }): Promise<Research | undefined> {
  if (turn.purpose !== 'mentor' || turn.opening || turn.stepSummary) return undefined;
  try {
    if (!(await readResearchToolsConfig(admin)).config.enabled) return undefined;
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
    return researchContextSchema.parse({ note: RESEARCH_CARDS_NOTE, cards: out,
      benchmarks: { required: POSITIONING_QUALIFIED_BENCHMARKS, qualified, rows: shown } });
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

/** The mentor turn's research host state: a refresh grant the user pressed (#1014) and the benchmark flow records. */
export async function withMentorResearch(admin: SupabaseClient, actorId: string, sessionId: string,
  request: { purpose: string; researchRefreshId?: string }, turn: { opening: boolean; stepSummary: boolean },
  context: HostTurnContext): Promise<HostTurnContext> {
  const refreshed = withResearchRefresh(context, await researchRefreshContext(admin, actorId, sessionId, request, turn));
  return withResearchContext(refreshed, await researchHostContext(admin, actorId, sessionId, { ...turn, purpose: request.purpose }));
}
