/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {randomUUID} from 'node:crypto';
import type {FrozenPaygRun, FrozenRun} from '../bill2/service';
import {logger} from '../../lib/logger';
import {attachResearchTurn} from './researchAdmission';
import type {ResearchAdmissionRejection} from './researchAdmissionDiagnostics';
import {hostTurnContextSchema, type HostTurnContext} from './hostTurn';
import {StagingAccessError} from './stagingErrors';
import {profileLinksIn} from '../research/tools/accountLinks';

/** The published field contract (CONVERSATION_CAPTURE_WRITEBACK_V2_FIELDS), not a step number, title or user text. */
export function requiresBenchmarkResearch(host: HostTurnContext | undefined): boolean {
  return Boolean(host?.checklist.find(step => step.id === host.stepId)?.fields.some(field => field.id === 'benchmark_findings'));
}
/** Keep the existing host byte cap even when its values already fill the envelope. Refusal remains fail-closed. */
export function researchInputHost(host: HostTurnContext | undefined, enabled: boolean): HostTurnContext | undefined {
  if (!enabled || !host || host.opening || host.stepSummary || !requiresBenchmarkResearch(host)) return host;
  const projected = {...host, materialProjection: 'checklist-dedup-v1' as const};
  return hostTurnContextSchema.safeParse(projected).success ? projected : host;
}
const benchmarkTools = ['propose_keywords', 'benchmark_discover', 'propose_more_candidates', 'benchmark_fetch'] as const;
/** Checking a pasted account needs only the fetch tool. */
const linkTools = ['benchmark_fetch'] as const;
type AttachInput = Parameters<typeof attachResearchTurn>[0];
type GuardInput = Omit<AttachInput, 'billing' | 'onRejected' | 'requiredTools'> & {
  billing: FrozenRun | FrozenPaygRun; actorId: string; sessionId: string; requestId: string;
  /** The user's own words this turn (not the framed model input). */
  userText?: string;
};
/**
 * A turn that carries a profile link asks for that account to be checked (benchmark_fetch, source user_message), on any
 * step. It then needs the tools as much as a benchmark step does: refusing before any charge beats a paid reply that
 * says "no tool". Same parser as authorizeBenchmarkFetch, so only whole profile links count.
 */
export const carriesAccountLink = (userText: string | undefined): boolean => Boolean(userText) && profileLinksIn(userText!).length > 0;

/** Await the existing server-only log insert; a log outage still leaves the same sanitized event in platform logs. */
async function recordRejection(input: GuardInput, rejection: ResearchAdmissionRejection, required: boolean) {
  const context = {version: 1, diagnosticId: randomUUID(), sessionId: input.sessionId, required, ...rejection};
  let persisted = false;
  try {
    const result = await input.admin.from('application_logs').insert({level: 'warn', category: 'api',
      message: 'research_admission_rejected', user_id: input.actorId, request_id: input.requestId, context})
      .abortSignal(AbortSignal.timeout(3000));
    persisted = !result.error;
  } catch { /* Never log raw transport/SQL errors or turn text. */ }
  logger.warn('api', 'research_admission_rejected', {...context, requestId: input.requestId, persisted});
}

/** Called before runtime_admit: refusal creates no execution/reservation and cannot start a paid model or supplier call. */
export async function guardResearchAdmission(input: GuardInput): Promise<boolean> {
  const benchmarkStep = requiresBenchmarkResearch(input.context.hostTurnContext);
  const required = benchmarkStep || carriesAccountLink(input.userText);
  let rejection: ResearchAdmissionRejection = {reason: 'BILLING_PROFILE_UNAVAILABLE'};
  const attached = input.billing.contractVersion === 'bill2.v2' && await attachResearchTurn({...input, billing: input.billing,
    requiredTools: benchmarkStep ? benchmarkTools : required ? linkTools : undefined, onRejected: value => { rejection = value; }});
  if (attached) return true;
  await recordRejection(input, rejection, required);
  const capacity = rejection.reason === 'CONTEXT_CAPACITY';
  if (benchmarkStep) throw new StagingAccessError(capacity ? 'RESEARCH_TOOLS_CONTEXT_CAPACITY' : 'RESEARCH_TOOLS_UNAVAILABLE');
  if (required) throw new StagingAccessError(capacity ? 'RESEARCH_TOOLS_LINK_CONTEXT_CAPACITY' : 'RESEARCH_TOOLS_LINK_UNAVAILABLE');
  return false;
}
