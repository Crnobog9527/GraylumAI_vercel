/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isEmailVerified } from '../../lib/auth';
import { workflowSchema } from '../artifacts/workflow';
import { researchShortfall } from '../research/runtime/userApi';
import { reportStart } from './contract';
import { reportError } from './service';

export const reportPreflightInput = reportStart.omit({ requestId: true });

/** Display-only, without admitting work or reserving credits. SQL admission checks the same facts again. */
export async function reportPreflight(user: SupabaseClient, admin: SupabaseClient, value: unknown) {
  const input = reportPreflightInput.parse(value);
  try {
    const auth = await user.auth.getUser();
    if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user)) throw new Error('REPORT_UNAVAILABLE');
    const actorId = auth.data.user.id;
    // Prove both session ownership and this project's round before returning any benchmark counts.
    const source = await admin.rpc('report_source', { p_actor_id: actorId, p_session_id: input.sessionId,
      p_project_id: input.projectId, p_round_id: input.roundId });
    if (source.error) throw source.error;
    const workflow = workflowSchema.parse(source.data?.workflow);
    if (!workflow.reportGeneration) throw new Error('REPORT_MANIFEST_REQUIRED');
    const required = Math.max(3, workflow.reportGeneration.minQualifiedBenchmarks ?? 3);
    const shortfall = await researchShortfall(admin, actorId, input.sessionId);
    // 0320: an offered generate choice remains the latest card; later offers reuse it. Do not
    // infer consent from a chat message or waive its minimum of one qualified account/two rounds.
    const accepted = shortfall.qualified >= 1 && shortfall.rounds >= 2
      && shortfall.card?.choice === 'generate' && shortfall.card.required >= required;
    return { ...shortfall, required, canGenerate: shortfall.qualified >= required || accepted };
  } catch (error) { reportError(error); }
}
