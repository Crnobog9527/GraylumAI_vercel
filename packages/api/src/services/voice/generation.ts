/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc, type BillingTransport } from '../bill2/service';
import { OPENROUTER_RESPONSE_TIMEOUT_MS } from '../bill2/openRouterPolicy';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { newWorkGate, type RuntimeCallGate } from '../runtime/newWorkGate';
import { runtimeGateEnvironment } from '../runtime/realHost';
import { stagingTransport } from '../runtime/stagingTransport';
import { fusionResponseText } from '../fusion/executor';
import { admitVoiceRun, type AdmittedVoiceRun } from './admission';
import { parseVoiceProfile, type VoiceMaterial } from './profile';
import { voiceRpc, type VoiceVersion } from './state';

type Billing = ReturnType<typeof authoritativeBilling>;
export type VoiceGenerationDeps = { admin: SupabaseClient; actorId: string; env?: Record<string, string | undefined>;
  budget?: RuntimeBudget;
  /** Tests inject a transport and a call gate; the host uses the staging/production transport and the rate limit. */
  transport?: (run: AdmittedVoiceRun, budget: RuntimeBudget) => BillingTransport;
  callGate?: (run: AdmittedVoiceRun) => RuntimeCallGate };
type Begun = { replayed: boolean; version: VoiceVersion; material?: VoiceMaterial[] };

/** 5.3 step 1–3: "学习我的文风". Freezes the corpus, makes one billed call on the summary model, parses the answer by code
 * and saves it as a draft (or stale, when the corpus changed meanwhile). The user is charged what the call cost, as
 * for any organizer call; nothing is estimated or shown beforehand (Owner rule: no estimated charge on the page). */
export async function generateVoiceProfile(deps: VoiceGenerationDeps, requestId: string, preferred: string[]): Promise<VoiceVersion> {
  const { admin, actorId } = deps;
  const begun = await voiceRpc<Begun>(admin, 'voice_generation_begin', { a: actorId, r: requestId, preferred });
  if (begun.replayed || !begun.material) return begun.version;
  const versionId = begun.version.id;
  const finish = (result: unknown, failure: string | null, settled: boolean) => voiceRpc<VoiceVersion | { status: 'deleted' }>(admin,
    'voice_generation_finish', { a: actorId, vid: versionId, result, failure_code: failure, settled });
  let run: AdmittedVoiceRun;
  try { run = await admitVoiceRun({ admin, actorId, versionId, material: begun.material, env: deps.env }); }
  catch (error) {
    await finish(null, codeOf(error, 'VOICE_UNAVAILABLE'), true);
    throw error;
  }
  const budget = deps.budget ?? createRuntimeBudget();
  const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => actorId, budget,
    adapter: deps.transport ? deps.transport(run, budget) : stagingTransport(admin, run.window, budget) });
  const gate = deps.callGate ? deps.callGate(run) : newWorkGate(admin, runtimeGateEnvironment(run.window)).calls;
  const outcome = await execute(billing, gate, run, actorId, versionId, budget, begun.material, finish);
  const saved = outcome.saved ?? await finish(null, outcome.failure, outcome.settled);
  if (saved.status === 'deleted') throw new Error('VOICE_VERSION_GONE');
  return saved as VoiceVersion;
}

/** Only a final run state ends billing; cost_pending keeps its hold and stays with the daily recovery. */
export const isSettled = (view: { state?: string }) => view.state === 'settled' || view.state === 'refunded';

type Saved = VoiceVersion | { status: 'deleted' };
type Outcome = { saved?: Saved; failure: string; settled: boolean };

async function execute(billing: Billing, callGate: RuntimeCallGate, run: AdmittedVoiceRun, actorId: string, versionId: string,
  budget: RuntimeBudget, material: VoiceMaterial[],
  finish: (result: unknown, failure: string | null, settled: boolean) => Promise<Saved>): Promise<Outcome> {
  /** No usable answer: undispatched calls are released, a dispatched one settles at its known cost (as a Fusion stop). */
  const cancel = async (failure: string): Promise<Outcome> => {
    await billing.requestCancel(run.runId);
    return { failure, settled: isSettled(await billing.finalizeRun(run.runId)) };
  };
  const gate = await callGate(actorId, 1, 'bill2.v2');
  if (!gate.ok) return cancel(gate.reason === 'paused' ? 'VOICE_PAUSED' : 'VOICE_RATE_LIMITED');
  const claimed = await billing.claimPaygCall(run.runId, 1, run.call);
  if (claimed.id === null) return cancel('VOICE_INSUFFICIENT_CREDITS');
  budget.modelCallTimeout(OPENROUTER_RESPONSE_TIMEOUT_MS);
  let dispatch: Awaited<ReturnType<Billing['dispatchOnce']>>;
  try { dispatch = await billing.dispatchOnce(claimed.id, run.body); }
  catch { return { failure: 'VOICE_RESULT_PENDING', settled: false }; }
  if (!dispatch.dispatched || dispatch.transportNotStarted) return cancel('VOICE_UNAVAILABLE');
  if (dispatch.accountClosed || dispatch.contentDeleted) return { failure: 'VOICE_UNAVAILABLE', settled: false };
  if (dispatch.pendingReceipt) {
    try { await billing.recordReceipt(dispatch.pendingReceipt.runId, dispatch.pendingReceipt.callId, dispatch.pendingReceipt.evidence); }
    catch { return { failure: 'VOICE_RESULT_PENDING', settled: false }; }
  }
  if (dispatch.providerRejectionPending) return { failure: 'VOICE_RESULT_PENDING', settled: false };
  if (dispatch.providerRejected) return cancel('VOICE_PROVIDER_REJECTED');
  const text = fusionResponseText(dispatch.observation, run.call.model);
  const profile = text ? parseVoiceProfile(text, material) : null;
  if (!profile) return cancel('VOICE_FORMAT_INVALID');
  // The profile is saved before the run is closed as delivered: a failure after this point leaves a saved profile and
  // an open run that the daily recovery settles, never a charge without the result.
  const saved = await finish(profile, null, false);
  const ref = `voice:${versionId}`;
  await billing.closeRun(run.runId, 'delivered', { kind: 'usable_result', evidenceRef: ref,
    evidenceHash: createHash('sha256').update(ref).digest('hex') });
  const settled = isSettled(await billing.finalizeRun(run.runId));
  return { saved: settled ? await finish(null, null, true) : saved, failure: '', settled };
}

const codeOf = (error: unknown, fallback: string) =>
  error instanceof Error && /^VOICE_[A-Z_]+$/.test(error.message) ? error.message : fallback;
