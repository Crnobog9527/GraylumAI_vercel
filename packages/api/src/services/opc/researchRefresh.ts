/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b PR-2: the "refresh" button's grant travels with the next user message (#1007 comment
// 6189354483). The host checks it against the signed-in user, this draft's session and the granted account, and
// hands it to the model as trusted turn context. benchmark_fetch checks the same grant again and consumes it once
// (0263); nothing here sends a request or charges.
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readResearchToolsConfig } from '../research/vendors/config';
import { canonicalAccount } from '../research/tools/accountLinks';
import { SOCIAL_PLATFORMS } from '../research/vendors/types';
import { RESEARCH_REFRESH_NOTE, type HostTurnContext } from '../runtime/hostTurn';

const grant = z.object({ platform: z.enum(SOCIAL_PLATFORMS), account: z.string().min(1).max(200), used: z.boolean() }).nullable();

/** Only a non-opening mentor answer to the user's own message can carry a refresh. */
export async function researchRefreshContext(admin: SupabaseClient, actorId: string, sessionId: string,
  request: { purpose: string; researchRefreshId?: string }, turn: { opening: boolean; stepSummary: boolean },
): Promise<HostTurnContext['researchRefresh']> {
  const refreshId = request.researchRefreshId;
  if (refreshId === undefined) return undefined;
  if (request.purpose !== 'mentor' || turn.opening || turn.stepSummary) throw new Error('OPC_RESEARCH_REFRESH_INVALID');
  // With the research tools switched off the model could not use it; refuse before any model call.
  if (!(await readResearchToolsConfig(admin)).config.enabled) throw new Error('OPC_RESEARCH_REFRESH_UNAVAILABLE');
  const read = await admin.rpc('research_runtime_read', { a: actorId, s: sessionId, e: null, p_kind: 'refresh', p_id: refreshId });
  if (read.error) {
    if (z.object({ message: z.literal('RESEARCH_SCOPE_DENIED') }).safeParse(read.error).success) {
      throw new Error('OPC_RESEARCH_REFRESH_INVALID');
    }
    throw new Error('OPC_RESEARCH_UNAVAILABLE');
  }
  const parsed = grant.safeParse(read.data);
  if (!parsed.success) throw new Error('OPC_RESEARCH_UNAVAILABLE');
  // Another user's, another session's, a deleted answer's or an already used grant reads as null or used.
  if (!parsed.data || parsed.data.used) throw new Error('OPC_RESEARCH_REFRESH_INVALID');
  const account = canonicalAccount(parsed.data.platform, parsed.data.account);
  if (!account) throw new Error('OPC_RESEARCH_REFRESH_INVALID');
  return { refreshId, platform: parsed.data.platform, account, note: RESEARCH_REFRESH_NOTE };
}

export function withResearchRefresh(context: HostTurnContext, refresh: HostTurnContext['researchRefresh']): HostTurnContext {
  return refresh ? { ...context, researchRefresh: refresh } : context;
}
