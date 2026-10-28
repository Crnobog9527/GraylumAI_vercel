/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { reportModelErrorCode } from './modelErrors';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isEmailVerified } from '../../lib/auth';
import { snapshotSchema } from '../artifacts/public';
import { workflowSchema } from '../artifacts/workflow';
import { runtimeAdmissionService, type LocalRuntimePolicy } from '../runtime/admission';
import { readNativeRuntimeView } from '../runtime/nativeView';
import { reportFee, reportPrice } from './fees';
import { benchmarkReportFacts, benchmarkShortfallNote, completeReportCandidate, confirmedReportFacts, frozenReport, reportInstructions,
  reportStart, REPORT_INPUT_BYTES, REPORT_REQUEST_INPUT, REPORT_SETTING } from './contract';

export const reportLocate = reportStart.omit({ requestId: true });
export { REPORT_REQUEST_INPUT };
/** At most this many newest candidates are confirmed by their frozen identity. */
const REPORT_LATEST_CANDIDATES = 20;
export const reportCodes = new Set(['OPC_BUSINESS_ARCHIVED', 'REPORT_DISABLED', 'REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE',
  'REPORT_SOURCE_CONFLICT', 'REPORT_CONFIRMATION_REQUIRED', 'REPORT_FACTS_TOO_LARGE', 'REPORT_MANIFEST_REQUIRED',
  'REPORT_PAYG_REQUIRED', 'OPC_CAPTURE_PENDING', 'REPORT_EXECUTION_REQUIRED', 'REPORT_REQUEST_CONFLICT', 'REPORT_ALREADY_EXISTS',
  'REPORT_BENCHMARKS_REQUIRED',
  // 0295: the balance does not cover the report's fixed price plus its call's temporary hold.
  'REPORT_CREDITS', 'REPORT_PRICE_CHANGED', 'REPORT_PRICE_REQUIRED']);
/**
 * A saved report execution blocks a new paid start while it is a complete report, or still going or waiting for
 * credits/resume. One that ended without a complete report (failed, cut off, stopped, empty) had its fixed price
 * settled under the report stop policy, so a new start is allowed and pays the price again.
 */
export function reportBlocksNewStart(saved: { state?: string; result?: { body?: string; completeness?: string } | null;
  context?: { reportGeneration?: unknown } }) {
  const frozen = frozenReport.safeParse(saved.context?.reportGeneration);
  // The same structural check as the page and the refund (every section present and filled, within the limit).
  if (typeof saved.result?.body === 'string' && saved.result.body.length > 0
    && (!frozen.success || completeReportCandidate(saved.result.body, saved.result.completeness, frozen.data))) return true;
  return !['completed', 'cancelled'].includes(String(saved.state));
}
export function reportError(error: unknown): never {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? error.message : null;
  const modelCode = reportModelErrorCode(message);
  throw new TRPCError({ code: ['REPORT_MEMBERSHIP_REQUIRED', 'OPC_BUSINESS_ARCHIVED'].includes(String(message)) ? 'FORBIDDEN' : 'BAD_REQUEST',
    cause: error, message: modelCode ?? (typeof message === 'string' && reportCodes.has(message) ? message : 'REPORT_UNAVAILABLE') });
}
/** The server switch: only a strict `{enabled:true}` setting enables NEW report admission. */
export async function reportEnabled(admin: SupabaseClient) {
  const setting = await admin.from('system_settings').select('value').eq('key', REPORT_SETTING).maybeSingle();
  if (setting.error) throw new Error('REPORT_UNAVAILABLE');
  const enabled: unknown = setting.data?.value;
  return z.object({ enabled: z.literal(true) }).strict().safeParse(enabled).success;
}
/**
 * Host-computed benchmark numbers for report facts (the qualified-count gate itself is in SQL report admission).
 * Rollout: before 0268 the RPC does not exist (PGRST202); the report is then built as before, with no rows or hash.
 */
export async function reportBenchmarks(admin: SupabaseClient, actorId: string, sessionId: string) {
  const rows = await admin.rpc('research_benchmark_rows', { a: actorId, s: sessionId });
  if (rows.error?.code === 'PGRST202') return { serialized: null, hash: undefined };
  if (rows.error) throw new Error('REPORT_UNAVAILABLE');
  return benchmarkReportFacts(rows.data);
}
export function reportService(user: SupabaseClient, admin: SupabaseClient, policy: LocalRuntimePolicy) {
  async function actor() {
    const auth = await user.auth.getUser();
    if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user)) throw new Error('REPORT_UNAVAILABLE');
    return auth.data.user.id;
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const result = await admin.rpc(name, { ...args, p_actor_id: await actor() });
    if (result.error) reportError(result.error);
    return result.data;
  }
  /**
   * The newest report execution of this project/round in the session and its saved row, or null.
   * Read only, through the granted runtime RPCs (the tables are not readable directly):
   * runtime_view proves the actor owns the session and lists its executions; executions carrying
   * the report's own request text are then confirmed by their frozen report identity, the same
   * read reportStatus uses.
   */
  async function findLatest(input: z.infer<typeof reportLocate>) {
    const actorId = await actor();
    let view: { executions: Array<{ executionId?: unknown; input?: unknown; request?: unknown; createdAt?: unknown }> };
    try { view = await readNativeRuntimeView(admin, actorId, input.sessionId); } catch { reportError(new Error('REPORT_UNAVAILABLE')); }
    const candidates = view.executions
      .filter(item => item.input === REPORT_REQUEST_INPUT && item.request == null && typeof item.executionId === 'string')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, REPORT_LATEST_CANDIDATES);
    for (const item of candidates) {
      const saved = await rpc('runtime_execution', { p_execution_id: item.executionId, p_action: 'read' });
      const frozen = frozenReport.safeParse(saved?.context?.reportGeneration);
      if (frozen.success && frozen.data.projectId === input.projectId && frozen.data.roundId === input.roundId)
        return { executionId: item.executionId as string,
          saved: saved as { state?: string; result?: { body?: string; completeness?: string } | null; context?: { reportGeneration?: unknown } } };
    }
    return null;
  }
  return {
    async start(value: unknown) {
      // acceptedCredits: the price the button showed; a start at another price is refused, never charged silently.
      const { acceptedCredits, ...input } = reportStart.extend({ acceptedCredits: z.number().int().positive().optional() }).parse(value);
      try {
        const replay = await rpc('runtime_admission_replay', { p_request_id: input.requestId, p_request: { reportStart: input } });
        if (replay) return replay;
        if (!await reportEnabled(admin)) throw new Error('REPORT_DISABLED');
        // A new start must carry the price the button showed (none shown: no start) and it must still be the price.
        if (acceptedCredits === undefined) throw new Error('REPORT_PRICE_REQUIRED');
        if (acceptedCredits !== await reportPrice(admin)) throw new Error('REPORT_PRICE_CHANGED');
        const source = await rpc('report_source', {
          p_session_id: input.sessionId, p_project_id: input.projectId, p_round_id: input.roundId,
        });
        const workflow = workflowSchema.parse(source.workflow);
        if (!workflow.reportGeneration) throw new Error('REPORT_MANIFEST_REQUIRED');
        const manifest = workflow.reportGeneration;
        // Check support before membership; the second membership check remains in SQL call reservation.
        await rpc('report_membership_check', {});
        // One paid report per round: a stale tab or device with a new requestId gets the existing one.
        // After report_source, so ownership and source refusals keep their own codes.
        // Simultaneous starts are already serialized by the session's active-execution lock.
        const existing = await findLatest(input);
        if (existing && reportBlocksNewStart(existing.saved)) throw new Error('REPORT_ALREADY_EXISTS');
        const snapshot = snapshotSchema.parse(source.snapshot);
        const facts = confirmedReportFacts(snapshot);
        const benchmarks = await reportBenchmarks(admin, await actor(), input.sessionId);
        const reportGeneration = frozenReport.parse({ version: 1, projectId: input.projectId, roundId: input.roundId,
          evidenceIds: [...new Set(Object.values(snapshot.steps).flatMap(step => [...step.evidenceIds, ...step.provenanceIds]))],
          snapshotHash: source.snapshotHash, packageHash: snapshot.packageHash, workflowHash: snapshot.workflowHash,
          templateHash: snapshot.templateHash, sections: manifest.sections, maxCharacters: manifest.maxCharacters,
          benchmarkHash: benchmarks.hash, ...(manifest.data ? { data: manifest.data } : {}) });
        // Same minimum as SQL research_benchmark_required for a positioning report (never below 3).
        const shortfall = benchmarkShortfallNote(benchmarks.serialized, Math.max(3, manifest.minQualifiedBenchmarks ?? 3));
        const instructions = reportInstructions(manifest, facts.serialized, benchmarks.serialized, shortfall);
        return await runtimeAdmissionService(user, admin, { ...policy, reportGeneration, maxCalls: 1,
          inputBytes: REPORT_INPUT_BYTES, historyItems: 0, searchEnabled: false, workspaceContext: false,
          skillResources: manifest.resources, additionalInstructions: instructions, purposeBudgets: true,
        }).prepare({ sessionId: input.sessionId, requestId: input.requestId, input: REPORT_REQUEST_INPUT,
          selection: { kind: 'skill', moduleId: source.moduleId, revisionId: snapshot.revisionId },
          organizeAfter: false, sources: [], network: 'deny' });
      } catch (error) { reportError(error); }
    },
    /** The newest report execution of this project/round in the session (see findLatest), or null. */
    async latest(value: unknown) {
      return { executionId: (await findLatest(reportLocate.parse(value)))?.executionId ?? null };
    },
    async status(executionId: string) {
      // No membership check on saved output. Existing SQL checks actor, scope and source permissions.
      const saved = await rpc('runtime_execution', { p_execution_id: z.string().uuid().parse(executionId), p_action: 'read' });
      const parsed = frozenReport.safeParse(saved.context?.reportGeneration);
      if (!parsed.success) reportError(new Error('REPORT_EXECUTION_REQUIRED'));
      const report = parsed.data;
      const result = saved.result as { body?: string; completeness?: string } | null;
      // Settle the held report price using the terminal outcome and the user-stop policy.
      // Rollout: before 0295 the function does not exist (PGRST202); reports then show no price, as before.
      const settled = await admin.rpc('report_fee_settle', { p_actor_id: await actor(), p_execution_id: executionId });
      if (settled.error && settled.error.code !== 'PGRST202') reportError(settled.error);
      const fee = settled.error ? null : settled.data;
      return { executionId, state: saved.state, cursor: saved.cursor, epoch: saved.epoch,
        fee: fee === null ? null : reportFee.parse(fee),
        body: result?.body ?? null, completeness: result?.completeness ?? null,
        candidate: Boolean(result?.body && completeReportCandidate(result.body, result.completeness, report)),
        code: saved.state === 'waiting_credits' ? 'RUNTIME_WAITING_CREDITS'
          : saved.state === 'waiting_resume' ? 'RUNTIME_WAITING_RESUME' : null };
    },
  };
}
