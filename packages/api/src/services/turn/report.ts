/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { snapshotSchema } from '../artifacts/public';
import { workflowSchema } from '../artifacts/workflow';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { withBrandIdentity } from '../modelIdentity/brandIdentity';
import { benchmarkReportFacts, benchmarkShortfallNote, completeReportCandidate, confirmedReportFacts, frozenReport, type FrozenReport,
  reportInstructions, REPORT_INPUT_BYTES, REPORT_REQUEST_INPUT } from '../report/contract';
import { DEFAULT_REPORT_PRICE, REPORT_PRICE_KEY } from '../report/fees';
import { readAdmissionConfiguration, readAdmissionModule, type ConfigurationRows } from '../runtime/admissionConfiguration';
import { rowFor } from '../runtime/settingsRows';
import { swallow } from '../../lib/swallow';
import { assertRuntimeRequestCapacity } from '../runtime/context';
import { readAdmissionSettings } from '../runtime/newWorkGate';
import { freezeSharedPromptCache } from '../runtime/promptCache';
import { AGENT_TURN_REQUEST_FORMAT, openRouterRequestBody, type RequestContext } from '../runtime/providerRequest';
import { readPurposeBudgets } from '../runtime/purposeBudgets';
import { runRuntime } from '../runtime/runner';
import { modelCall, TurnStop } from './call';
import { GATE_CODES, readCoreConfig, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError, type CloseKind } from './db';
import { turnSession } from './history';
import { callCredits, turnPolicy } from './policy';
import { chatQuote, QuoteError } from './quote';
import { reportSkillText } from './reportSkill';
import type { TurnEvent } from './sse';

/*
 * CORE-PATH-V2 kind=report (2.7, 4.1, 4.4; V2-7a). One long model call (32768 output, no continuation, 10-07) at a fixed price
 * (Owner 10-17: 500 credits, frozen when generating starts, charged only for a complete report; failed, cut off or deleted pays
 * nothing; a new start after that pays again). Database work is the five writes of a one-call turn: turn_open (which admits the
 * report under its locks: price, membership, confirmed source, benchmarks, one per round), the call's three writes, turn_close.
 * The prompt is the Skill text (shared, cached by package hash in the process) then the report's facts, each block a cache
 * breakpoint (prompt-cache-v3, 2.9; moved here from #1501, whose old path could not freeze a cache for reports).
 * Stop (the only kind that can be stopped, 10-28): POST /api/turn/stop records it (turn_stop: first two in 24 hours free, the
 * third and later after the user's confirmation charge what was generated, at most the fixed price); the page then drops this
 * stream, and the dropped stream makes this turn read its state once: a stopped turn aborts the provider stream and closes as
 * stopped with what was generated (turn_close keeps what the user saw). A stream dropped without a stop changes nothing.
 */
export const reportTurnRequest = z.object({
  kind: z.literal('report'), sessionId: z.string().uuid(), requestId: z.string().uuid(),
  moduleId: z.string().uuid(), projectId: z.string().uuid(), roundId: z.string().uuid(),
  // The price the button showed; a start at another price is refused, never charged silently.
  acceptedCredits: z.number().int().positive(),
}).strict();
export type ReportInput = Omit<z.infer<typeof reportTurnRequest>, 'kind'> & { actorId: string };

const OPEN_CODES = /^(REPORT_[A-Z_]+|TURN_[A-Z_]+|STOP_LOSS_REACHED)$/;
/** What turn_open's report branch returns (its kindContext): the confirmed source and benchmark table, read under its locks. */
const reportContext = z.object({
  source: z.object({ snapshot: z.unknown(), workflow: z.unknown(), snapshotHash: z.string() }).passthrough(), benchmarks: z.unknown() });

/** The fixed price from the admission configuration rows (the database checks the same row when it opens the turn). */
function reportPrice(configuration: ConfigurationRows): number {
  const row = rowFor(configuration, REPORT_PRICE_KEY);
  if (row.error) throw new Error('REPORT_UNAVAILABLE');
  if (!row.data) return DEFAULT_REPORT_PRICE;
  const parsed = z.coerce.number().int().min(1).max(999999).safeParse(row.data.value);
  if (!parsed.success) throw new Error('REPORT_UNAVAILABLE');
  return parsed.data;
}

export async function runReportTurn(deps: ChatDeps, input: ReportInput, emit: (event: TurnEvent) => void,
  clientGone?: AbortSignal): Promise<void> {
  const { admin } = deps, db = turnDatabase(deps.clients);
  // 1. The catalog (cached): switch, price, module and its report model, input budget, the quote of the one call.
  const configuration = readAdmissionConfiguration(admin);
  const config = readCoreConfig(await configuration);
  if (!config) return emit({ type: 'error', code: 'TURN_CORE_DISABLED' });
  const settings = await readAdmissionSettings(admin, configuration);
  // The one-switch pause and the message limits, before anything is frozen (as a chat).
  const admitted = await deps.newWork.message(input.actorId, Promise.resolve(settings));
  if (!admitted.ok) return emit({ type: 'error', code: GATE_CODES[admitted.reason] });
  let quote, price: number;
  try {
    price = reportPrice(await configuration);
    if (input.acceptedCredits !== price) return emit({ type: 'error', code: 'REPORT_PRICE_CHANGED' });
    const module = await readAdmissionModule(admin, input.moduleId);
    if (module.error || module.data?.active !== true) return emit({ type: 'error', code: 'REPORT_SOURCE_CONFLICT' });
    // Back-office report model (10-10), else the module's model, as the old report admission chose it.
    const modelId = z.string().uuid().parse(module.data.report_model_id ?? module.data.model_id);
    const budgets = await readPurposeBudgets(admin, configuration);
    quote = await chatQuote(admin, { configuration: await configuration, modelId,
      inputBytes: budgets?.report.inputBytes ?? REPORT_INPUT_BYTES, deps: deps.pricing,
      use: { phase: 'report', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'interactive' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return emit({ type: 'error', code: error instanceof QuoteError ? error.code : /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message
      : 'TURN_QUOTE_UNAVAILABLE' });
  }
  const guard = settings.ok ? settings.identityGuard ?? true : true;

  // 2. Open: one model call, no tools, no history. The user's freeze is the fixed price plus the call's bound (10-17: the
  // balance must cover both, or nothing opens); the stop-loss reserves the call's bound only (2.5.3).
  const held = price + callCredits(quote.q, quote.upperUsd, quote.multiplier);
  // The start threshold L of a report is its whole freeze (Owner 10-28 restating 10-01 for metered turns; a fixed-price report
  // freezes the price and the call's bound at open and never pauses for credits): the balance must cover all of it.
  const base = turnPolicy({ q: quote.q, multiplier: quote.multiplier, modelUpperUsd: quote.upperUsd, startThresholdCredits: held,
    limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, stopLoss: config.stopLoss, historyItems: 0,
    inputBytes: quote.inputLimit, pricing: quote.pricing, frozen: { modelId: quote.modelId, model: quote.model } });
  const policy = { ...base, fixedCredits: price, gCredits: held,
    report: { projectId: input.projectId, roundId: input.roundId, moduleId: input.moduleId } };
  let opened;
  try { opened = await db.open({ actorId: input.actorId, sessionId: input.sessionId, requestId: input.requestId, kind: 'report', policy }); }
  catch (error) {
    const code = error instanceof TurnDatabaseError ? error.code : 'TURN_OPEN_FAILED';
    return emit({ type: 'error', code: code === 'TURN_INSUFFICIENT_CREDITS' ? 'REPORT_CREDITS' : code });
  }
  emit({ type: 'opened', turnId: opened.turnId, reservedCredits: opened.reservedCredits, replay: opened.replay });
  if (opened.replay) return emit({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: opened.turnId });
  const turnId = opened.turnId;
  const close = (kind: CloseKind, extra: { body?: string; delivered?: boolean; failureCode?: string } = {}) =>
    db.close({ actorId: input.actorId, turnId, kind, delivered: extra.delivered ?? false, failureCode: extra.failureCode ?? null,
      // The report text is the kind's result (turn_report_apply keeps it hidden from history), never a conversation message.
      // With it, the report identity built from the source turn_open read: the edit and publish chain reads both (V2-7a).
      messages: [], ...(extra.body === undefined || !frozen ? {} : { kindResult: { body: extra.body, reportGeneration: frozen } }) });

  // A dropped stream: was it the user's stop? One read, only then. A stop aborts the provider stream below.
  const abort = new AbortController();
  let stopRead: Promise<void> | undefined;
  const onGone = () => {
    if (stopRead) return;
    // Unreadable: the report runs on (a dropped stream alone never stops it); the miss is logged.
    stopRead = swallow('turn_report_stop_read_failed', db.reportRead({ actorId: input.actorId, sessionId: input.sessionId,
      roundId: null, turnId }).then(turn => { if (turn?.state === 'stopping') abort.abort(); }), undefined, { category: 'api' });
  };
  if (clientGone?.aborted) onGone(); else clientGone?.addEventListener('abort', onGone, { once: true });

  let text = '', stopped: TurnStop | undefined, finish: unknown, frozen: FrozenReport | undefined;
  try {
    // 3. The prompt: the Skill text (site-wide per package) then the report's own instructions with the confirmed facts and the
    // benchmark table that turn_open read under its locks.
    const parsed = reportContext.safeParse(opened.kindContext);
    if (!parsed.success) throw new Error('REPORT_SOURCE_CONFLICT');
    const report = parsed.data;
    const snapshot = snapshotSchema.parse(report.source.snapshot);
    const manifest = workflowSchema.parse(report.source.workflow).reportGeneration;
    if (!manifest) throw new Error('REPORT_MANIFEST_REQUIRED');
    const facts = confirmedReportFacts(snapshot);
    const benchmarks = benchmarkReportFacts(report.benchmarks);
    const shortfall = benchmarkShortfallNote(benchmarks.serialized, Math.max(3, manifest.minQualifiedBenchmarks ?? 3));
    frozen = frozenReport.parse({ version: 1, projectId: input.projectId, roundId: input.roundId,
      snapshotHash: report.source.snapshotHash, packageHash: snapshot.packageHash, workflowHash: snapshot.workflowHash,
      templateHash: snapshot.templateHash, sections: manifest.sections, maxCharacters: manifest.maxCharacters,
      benchmarkHash: benchmarks.hash, ...(manifest.data ? { data: manifest.data } : {}) });
    const skill = await reportSkillText(admin, { actorId: input.actorId, moduleId: input.moduleId, skillId: snapshot.skillId,
      revisionId: snapshot.revisionId, packageHash: snapshot.packageHash, resources: manifest.resources, maxBytes: quote.inputLimit });
    const shared = withBrandIdentity(skill, guard);
    const instructions = shared + '\n' + reportInstructions(manifest, facts.serialized, benchmarks.serialized, shortfall);
    const promptCache = freezeSharedPromptCache({ real: true, model: quote.model, cacheWriteUsdPerMillion:
      quote.providerLimits.cacheWriteUsdPerMillion, instructions, prefixChars: shared.length, historyMarker: false });
    const context: RequestContext = { providerRequestFormat: AGENT_TURN_REQUEST_FORMAT, tools: [], network: 'deny',
      reasoning: quote.reasoning, ...(promptCache ? { promptCache } : {}) };
    const callPolicy = { modelId: quote.modelId, provider: 'openrouter', account: quote.identity.account, model: quote.model,
      protocol: 'openrouter-chat-v1' as const, providerLimits: quote.providerLimits, upperUsd: quote.upperUsd, outputLimit: quote.outputLimit,
      inputLimit: quote.inputLimit, automaticRetry: false, hiddenTools: false, lookupSupported: true };
    // The stop's abort reaches the provider request itself (its transport), never only this page's stream.
    const transport = deps.transport ?? fetch;
    const callDeps = { db, slots: deps.slots, actorId: input.actorId, turnId, nextSeq: (() => { let seq = 0; return () => ++seq; })(),
      adapter: openRouterAdapter({ credential: quote.credential,
        // Both signals: the adapter's own time budget (240 s) still ends a stuck request; the stop ends it at once.
        transport: ((url, init) => transport(url, { ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal })) as typeof fetch }) };
    const output = await runRuntime({
      model: quote.model, instructions, input: REPORT_REQUEST_INPUT, session: turnSession([]),
      maxOutputTokens: quote.outputLimit, maxTurns: 1, reasoning: quote.reasoning, tools: [], stream: true,
      selectHistory: async (items, incoming) => [...items, ...incoming],
      onText: delta => { text += delta; emit({ type: 'text', delta }); },
      exchange: async (_sequence, body, onChunk) => {
        const request = openRouterRequestBody(body, { context, policy: callPolicy as never, phase: 'report', primaryDialogue: true });
        try { assertRuntimeRequestCapacity(request, quote.inputLimit); }
        catch { stopped = new TurnStop('TURN_INPUT_TOO_LARGE'); throw stopped; }
        // The pause and the call limits again before the paid call: nothing is written or sent when refused.
        const gate = await deps.newWork.calls(input.actorId, 1, 'bill2.v2');
        if (!gate.ok) { stopped = new TurnStop(GATE_CODES[gate.reason]); throw stopped; }
        return modelCall(callDeps, quote, request, onChunk)
          .then(completion => { finish = (JSON.parse(completion) as { choices?: Array<{ finish_reason?: unknown }> })
            .choices?.[0]?.finish_reason; return completion; })
          .catch(error => { if (error instanceof TurnStop) stopped = error; throw error; });
      },
    });
    const body = output || text;
    // 4. Close: a complete report (every heading, within the limit, finished by the model) pays the fixed price; one cut off
    // pays nothing and is kept to read. A stop recorded meanwhile makes it the stopped report (turn_close).
    const delivered = completeReportCandidate(body, finish === 'stop' ? 'complete' : 'length_limit', frozen);
    const closed = await close('completed', { body, delivered });
    if (closed.closeKind === 'erased') return emit({ type: 'error', code: 'TURN_TOMBSTONED', turnId });
    emit({ type: 'result', turnId, body, chargedCredits: closed.chargedCredits, settlement: closed.settlement,
      closeKind: closed.closeKind, delivered: delivered && closed.closeKind === 'completed' });
  } catch (error) {
    const code = stopped ? stopped.code : error instanceof TurnStop ? error.code : error instanceof TurnDatabaseError ? error.code
      : error instanceof Error && OPEN_CODES.test(error.message) ? error.message : 'TURN_FAILED';
    // Stopped by its user: the aborted stream is the stopped report, with what was generated (turn_close cuts it to what the
    // user saw; its provider cost is looked up by recovery). Anything else delivered nothing and pays nothing (turn_close).
    if (abort.signal.aborted) {
      const closed = await swallow('turn_report_stop_close_failed', close('stopped', { body: text }), null, { category: 'api' });
      if (closed) return emit({ type: 'result', turnId, body: text, chargedCredits: closed.chargedCredits,
        settlement: closed.settlement, closeKind: closed.closeKind, delivered: false });
    } else {
      const kind: CloseKind = code === 'TURN_TOMBSTONED' ? 'erased' : code === 'TURN_CALL_UNKNOWN' ? 'interrupted' : 'failed';
      await swallow('turn_report_close_failed', close(kind, { failureCode: code.toLowerCase() }), undefined, { category: 'api' });
    }
    emit({ type: 'error', code, turnId });
  } finally {
    clientGone?.removeEventListener('abort', onGone);
    await stopRead;
  }
}
