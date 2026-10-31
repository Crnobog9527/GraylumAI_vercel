/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStop } from './call';
import type { ChatDeps } from './chat';
import { runReportTurn, type ReportInput } from './report';
import type { TurnEvent } from './sse';

/*
 * CORE-PATH-V2 V2-7a, Node side of kind=report with the database, the catalog and the provider faked (the database rules are
 * packages/db/tests/turn-core/report-cases.mjs): the price the button showed, the frozen numbers, the report prompt and its two
 * cache blocks, how each outcome closes, and the stop (a dropped stream reads the turn once; a stopping turn aborts the call).
 */
const h = vi.hoisted(() => ({
  request: [] as Array<{ context: Record<string, unknown>; phase: string }>,
  call: vi.fn(), runtime: vi.fn(), transports: [] as Array<typeof fetch>,
}));
vi.mock('./chat', async original => ({ ...await original<object>(), readCoreConfig: () => ({ enabled: true, decisionUpperUsd: '0.01',
  stopLoss: { limitUsd: 100, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } }) }));
vi.mock('../runtime/admissionConfiguration', async original => ({ ...await original<object>(), readAdmissionConfiguration: async () => ({ data: [{ key: 'report_fixed_price_credits', value: 500 }], error: null }),
  readAdmissionModule: async (_admin: unknown, id: string) => ({ error: null,
    data: { id, active: true, model_id: '20000000-0000-4000-8000-000000000001', report_model_id: '20000000-0000-4000-8000-000000000002' } }) }));
vi.mock('../runtime/purposeBudgets', async original => ({ ...await original<object>(), readPurposeBudgets: async () => null }));
vi.mock('../runtime/newWorkGate', async original => ({ ...await original<object>(), readAdmissionSettings: async () => ({ ok: true, identityGuard: false }) }));
vi.mock('./reportSkill', async original => ({ ...await original<object>(), reportSkillText: async () => 'SKILL TEXT' }));
vi.mock('../runtime/context', async original => ({ ...await original<object>(), assertRuntimeRequestCapacity: () => undefined }));
vi.mock('../runtime/providerRequest', async original => ({ ...await original<object>(),
  openRouterRequestBody: (_body: string, options: { context: Record<string, unknown>; phase: string }) => {
    h.request.push(options); return 'REQUEST'; } }));
vi.mock('../bill2/openRouterAdapter', async original => ({ ...await original<object>(), openRouterAdapter: (o: { transport: typeof fetch }) => { h.transports.push(o.transport); return {}; } }));
vi.mock('./call', async original => ({ ...await original<object>(), modelCall: h.call }));
vi.mock('../runtime/runner', async original => ({ ...await original<object>(), runRuntime: h.runtime }));
const pricing = { version: 'nominal-v1', pricingHash: 'a'.repeat(64), endpointTag: 'anthropic/exact',
  tiers: [{ minPromptTokens: 0, prompt: '3', completion: '15', request: '0' }], timeOfDay: [] };
const quote = { pricing, modelId: '20000000-0000-4000-8000-000000000002', model: 'anthropic/claude-sonnet-5.5', q: '100', multiplier: '6',
  upperUsd: '0.3', outputLimit: 32768, inputLimit: 196608, reasoning: { parameter: 'none' },
  providerLimits: { providerSlug: 'anthropic', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15',
    requestUsd: '0', cacheWriteUsdPerMillion: '3.75' },
  identity: { account: 'test' }, credential: async () => 'KEY', concurrency: 4 };
const chatQuote = vi.hoisted(() => vi.fn());
vi.mock('./quote', async original => ({ ...await original<object>(), chatQuote }));

const SESSION = '00000000-0000-4000-8000-000000000001', ROUND = '00000000-0000-4000-8000-000000000003';
const input: ReportInput = { actorId: 'actor', sessionId: SESSION, requestId: '00000000-0000-4000-8000-000000000002',
  moduleId: '00000000-0000-4000-8000-000000000004', projectId: '00000000-0000-4000-8000-000000000005', roundId: ROUND,
  acceptedCredits: 500 };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workflow = { id: 'w', version: 1, kind: 'document', steps: [{ id: 's', title: 'Facts', dependsOn: [], resources: ['step.md'], minLength: 1,
  maxLength: 20000, requiresEvidence: false, requiredCapabilities: [], information: [] }],
  report: { id: 'report', version: 1, title: 'Positioning', sections: [{ title: 'Facts', stepId: 's' }] }, planResources: ['report.md'],
  reportGeneration: { resources: ['report.md'], sections: ['One', 'Two'], maxCharacters: 12000 } };
const pre = {
  source: { snapshotHash: 'e'.repeat(64), workflow, snapshot: { projectId: input.projectId, roundId: ROUND, skillId: uuid(6),
    state: 'draft', currentVersion: 0, revisionId: uuid(7), packageHash: 'b'.repeat(64), workflowHash: 'c'.repeat(64),
    templateHash: 'd'.repeat(64), workflow, evidence: [], candidates: [], confirmations: [],
    steps: { s: { body: 'CONFIRMED', version: 1, reviewVersion: 0, evidenceIds: [], provenanceIds: [], confirmationId: uuid(8),
      valid: true, information: {} } } } },
  benchmarks: { rows: [], hash: 'f'.repeat(64) } };
const COMPLETE = '## One\nFirst.\n## Two\nSecond.';

function harness(over: { open?: () => unknown; openError?: string; state?: string; sourceError?: string; shortQualified?: number;
  membershipError?: string;
  gate?: { message?: { ok: false; reason: string }; calls?: { ok: false; reason: string } } } = {}) {
  const rpc: Array<[string, Record<string, unknown>]> = [];
  const respond = async (name: string, args: Record<string, unknown>) => {
    rpc.push([name, args]);
    // A refusal comes back as PostgREST's error object, as from the real database.
    if (name === 'turn_open' && over.openError) return { data: null, error: { code: 'P0001', message: over.openError, details: null } };
    if (name === 'turn_open') return { data: over.open?.() ?? { turnId: 9, state: 'running', replay: false, reservedCredits: 530,
      reservedUsd: 0.3, history: [], kindContext: null }, error: null };
    // The reads before opening (B1): the round's source, the benchmark table (empty here) and the shortfall card the user chose.
    if (name === 'report_source') return over.sourceError ? { data: null, error: { code: 'P0001', message: over.sourceError } }
      : { data: { ...pre.source, moduleId: input.moduleId }, error: null };
    if (name === 'report_membership_check') return over.membershipError
      ? { data: null, error: { code: 'P0001', message: over.membershipError } } : { data: null, error: null };
    if (name === 'research_benchmark_rows') return { data: pre.benchmarks, error: null };
    if (name === 'research_user_shortfall') return { data: { rounds: 2, qualified: over.shortQualified ?? 1,
      card: { cardId: uuid(9), required: 3, choice: 'generate' } }, error: null };
    if (name === 'turn_close') return { data: { turnId: 9, closeKind: args.p_close_kind === 'completed' && over.state === 'stopping'
      ? 'stopped' : args.p_close_kind, chargedCredits: args.p_delivered ? 500 : 0, absorbedCredits: 0, settlement: 'done', replay: false },
      error: null };
    if (name === 'turn_report_read') return { data: { turnId: 9, requestId: '00000000-0000-4000-8000-000000000009', state: over.state ?? 'running', closeKind: null, delivered: false,
      chargedCredits: null, settlement: null, fixedCredits: 500, stopChargeable: false, report: null, body: null,
      openedAt: 'x', closedAt: null }, error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  };
  const client = { rpc: respond, from: () => { throw new Error('no table reads'); } };
  const deps = { admin: {}, clients: { write: client, read: client }, slots: {},
    newWork: { message: async () => over.gate?.message ?? { ok: true }, calls: async () => over.gate?.calls ?? { ok: true } },
    transport: (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) =>
      init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch } as unknown as ChatDeps;
  const events: TurnEvent[] = [];
  return { rpc, deps, events, emit: (e: TurnEvent) => events.push(e), names: () => rpc.map(([n]) => n).filter(n => n.startsWith('turn_')),
    args: (name: string) => rpc.find(([n]) => n === name)![1] };
}
// The runner: one exchange, its text streamed, the completion's text returned.
function runs(text: string, finish = 'stop') {
  h.call.mockImplementation(async () => JSON.stringify({ choices: [{ finish_reason: finish, message: { content: text } }] }));
  h.runtime.mockImplementation(async (o: { exchange: (s: number, b: string, c?: unknown) => Promise<string>; onText: (d: string) => void }) => {
    await o.exchange(1, '{}'); o.onText(text); return text;
  });
}

describe('kind=report on the turn core (CORE-PATH-V2 V2-7a)', () => {
  beforeEach(() => { h.request.length = 0; h.transports.length = 0; h.call.mockReset(); h.runtime.mockReset();
    chatQuote.mockReset(); chatQuote.mockResolvedValue(quote); });

  it('refuses a start at a price other than the one the button showed, before anything opens', async () => {
    const t = harness();
    await runReportTurn(t.deps, { ...input, acceptedCredits: 400 }, t.emit);
    expect(t.events).toEqual([{ type: 'error', code: 'REPORT_PRICE_CHANGED' }]);
    expect(t.rpc).toEqual([]);
  });

  it('freezes the fixed price plus the call bound, for the report model, with the report quote use', async () => {
    const t = harness(); runs(COMPLETE);
    await runReportTurn(t.deps, input, t.emit);
    expect(chatQuote.mock.calls[0]![1]).toMatchObject({ modelId: '20000000-0000-4000-8000-000000000002',
      use: { phase: 'report', requestFormat: 'agent-turn-v5-stream' } });
    const policy = t.args('turn_open').p_policy as Record<string, unknown>;
    // One call: G = ceil(100 x 0.3 x 6) = 180; the user's freeze is 500 + 180, all of it or nothing.
    expect(policy).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', pricing, fixedCredits: 500, gCredits: 680, minCredits: 680, uModelCredits: 180, uTurnUsd: 0.3, historyItems: 0,
      limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 },
      report: { projectId: input.projectId, roundId: ROUND, moduleId: input.moduleId } });
    expect(t.args('turn_open').p_kind).toBe('report');
  });

  it('a complete report: five turn writes at most (open, the call, close), two cache blocks, saved and paid once', async () => {
    const t = harness(); runs(COMPLETE);
    await runReportTurn(t.deps, input, t.emit);
    expect(t.names()).toEqual(['turn_open', 'turn_close']);   // the call's three writes are modelCall's (call.test.ts)
    const { context, phase } = h.request[0]!;
    expect(phase).toBe('report');
    expect(context).toMatchObject({ providerRequestFormat: 'agent-turn-v5-stream', tools: [], network: 'deny',
      promptCache: { version: 'prompt-cache-v3', systemPrefixChars: 'SKILL TEXT'.length, historyMarker: false } });
    const close = t.args('turn_close');
    expect(close).toMatchObject({ p_close_kind: 'completed', p_delivered: true, p_messages: [], p_kind_result: { body: COMPLETE } });
    expect(t.events.at(-1)).toMatchObject({ type: 'result', chargedCredits: 500, closeKind: 'completed', delivered: true });
  });

  it('a report cut off by the output limit, or missing a heading, is kept but not delivered (pays nothing)', async () => {
    for (const [text, finish] of [[COMPLETE, 'length'], ['## One\nOnly one.', 'stop']] as const) {
      const t = harness(); runs(text, finish);
      await runReportTurn(t.deps, input, t.emit);
      expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: false });
      expect(t.events.at(-1)).toMatchObject({ type: 'result', chargedCredits: 0, delivered: false });
    }
  });

  it('a failure closes as failed, an unknown provider outcome as interrupted; a replayed request runs nothing', async () => {
    for (const [stop, kind] of [['TURN_PROVIDER_402', 'failed'], ['TURN_CALL_UNKNOWN', 'interrupted'], ['TURN_TOMBSTONED', 'erased']]) {
      const t = harness();
      h.call.mockRejectedValueOnce(new TurnStop(stop as 'TURN_PROVIDER_402'));
      h.runtime.mockImplementation(async (o: { exchange: (s: number, b: string) => Promise<string> }) => o.exchange(1, '{}'));
      await runReportTurn(t.deps, input, t.emit);
      expect(t.args('turn_close')).toMatchObject({ p_close_kind: kind });
      expect(t.events.at(-1)).toMatchObject({ type: 'error', code: stop });
    }
    const r = harness({ open: () => ({ turnId: 9, state: 'running', replay: true, reservedCredits: 530, reservedUsd: 0.3, history: [],
      kindContext: null }) });
    await runReportTurn(r.deps, input, r.emit);
    expect(r.names()).toEqual(['turn_open']);
    expect(r.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_REQUEST_REPLAYED' });
  });

  it('the stop: a dropped stream reads the turn once; stopping aborts the provider request and closes as stopped with the text', async () => {
    const t = harness({ state: 'stopping' }), gone = new AbortController();
    h.call.mockImplementation(async () => {
      try { await h.transports[0]!('https://openrouter.test', {}); } catch { throw new TurnStop('TURN_CALL_UNKNOWN'); }
      return '';
    });
    h.runtime.mockImplementation(async (o: { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void }) => {
      o.onText('## One\nPart'); setTimeout(() => gone.abort(), 0); return o.exchange(1, '{}');
    });
    await runReportTurn(t.deps, input, t.emit, gone.signal);
    expect(t.names()).toEqual(['turn_open', 'turn_report_read', 'turn_close']);
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'stopped', p_messages: [], p_kind_result: { body: '## One\nPart' } });
    expect(t.events.at(-1)).toMatchObject({ type: 'result', closeKind: 'stopped', delivered: false });
  });

  // Vercel never reports the dropped stream (staging turn 28): no client signal here, only the stop's flag.
  it('the stop reaches a running turn with no word of the dropped stream: its flag aborts the provider call, no database read', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const t = harness(), looks: number[] = [];
      const stopSignal = { raise: async () => undefined, raised: async (id: number) => { looks.push(id); return looks.length === 2; } };
      h.call.mockImplementation(async () => {
        const request = h.transports[0]!('https://openrouter.test', {});
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        try { await request; } catch { throw new TurnStop('TURN_CALL_UNKNOWN'); }
        return '';
      });
      h.runtime.mockImplementation(async (o: { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void }) => {
        o.onText('## One\nPart'); return o.exchange(1, '{}');
      });
      await runReportTurn(t.deps, input, t.emit, undefined, stopSignal);
      expect(looks).toHaveLength(2);
      expect(t.names()).toEqual(['turn_open', 'turn_close']);
      expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'stopped', p_kind_result: { body: '## One\nPart' } });
      expect(t.events.at(-1)).toMatchObject({ type: 'result', closeKind: 'stopped', delivered: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('a flag that cannot be read never stops a report, and the looking ends with the turn', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const t = harness(); runs(COMPLETE);
      const raised = vi.fn(async () => { throw new Error('redis down'); });
      h.call.mockImplementation(async () => { await vi.advanceTimersByTimeAsync(2000); return JSON.stringify({ choices: [{ finish_reason: 'stop' }] }); });
      h.runtime.mockImplementation(async (o: { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void }) => {
        await o.exchange(1, '{}'); o.onText(COMPLETE); return COMPLETE;
      });
      await runReportTurn(t.deps, input, t.emit, undefined, { raise: async () => undefined, raised });
      expect(raised).toHaveBeenCalledTimes(1);
      expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('a stream dropped without a stop (the page closed) changes nothing: the report runs to its end', async () => {
    const t = harness({ state: 'running' }), gone = new AbortController();
    runs(COMPLETE);
    h.runtime.mockImplementation(async (o: { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void }) => {
      gone.abort(); await new Promise(r => setTimeout(r, 0)); await o.exchange(1, '{}'); o.onText(COMPLETE); return COMPLETE;
    });
    await runReportTurn(t.deps, input, t.emit, gone.signal);
    expect(t.names()).toEqual(['turn_open', 'turn_report_read', 'turn_close']);
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true });
  });

  it('a refusal inside turn_open keeps its report code; a short balance is the report\'s own REPORT_CREDITS', async () => {
    for (const [message, code] of [['REPORT_MEMBERSHIP_REQUIRED', 'REPORT_MEMBERSHIP_REQUIRED'],
      ['REPORT_PRICE_CHANGED', 'REPORT_PRICE_CHANGED'], ['REPORT_ALREADY_EXISTS', 'REPORT_ALREADY_EXISTS'],
      ['TURN_INSUFFICIENT_CREDITS', 'REPORT_CREDITS'], ['OPC_BUSINESS_ARCHIVED', 'OPC_BUSINESS_ARCHIVED'], ['could not serialize access', 'TURN_DATABASE_UNAVAILABLE']]) {
      const t = harness({ openError: message });
      await runReportTurn(t.deps, input, t.emit);
      expect(t.events).toEqual([{ type: 'error', code }]);
    }
  });

  it('the stop does not replace the provider request\'s own time budget: either signal ends it', async () => {
    const t = harness(); runs(COMPLETE);
    await runReportTurn(t.deps, input, t.emit);
    const budget = new AbortController();
    const request = h.transports[0]!('https://openrouter.test', { signal: budget.signal });
    budget.abort();
    await expect(request).rejects.toThrow('aborted');
  });

  it('the one-switch pause refuses before anything opens; a call limit refuses before the paid call and pays nothing', async () => {
    const paused = harness({ gate: { message: { ok: false, reason: 'paused' } } });
    await runReportTurn(paused.deps, input, paused.emit);
    expect(paused.events).toEqual([{ type: 'error', code: 'TURN_NEW_CALLS_PAUSED' }]);
    expect(paused.rpc).toEqual([]);
    const limited = harness({ gate: { calls: { ok: false, reason: 'call_limited' } } });
    runs(COMPLETE);
    await runReportTurn(limited.deps, input, limited.emit);
    expect(h.call).not.toHaveBeenCalled();
    expect(limited.args('turn_close')).toMatchObject({ p_close_kind: 'failed' });
    expect(limited.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_RATE_LIMITED' });
  });

  it('reads the source and the benchmark gate before opening, on the read client; a refusal there opens nothing', async () => {
    const t = harness(); runs(COMPLETE);
    await runReportTurn(t.deps, input, t.emit);
    expect(t.rpc.map(([n]) => n).slice(0, 5)).toEqual(['report_membership_check', 'report_source', 'research_benchmark_rows',
      'research_user_shortfall', 'turn_open']);
    expect(t.args('report_source')).toEqual({ p_actor_id: 'actor', p_session_id: SESSION, p_project_id: input.projectId,
      p_round_id: ROUND });
    for (const [over, code] of [[{ membershipError: 'REPORT_MEMBERSHIP_REQUIRED' }, 'REPORT_MEMBERSHIP_REQUIRED'],
      [{ membershipError: 'REPORT_ENTITLEMENTS_UNAVAILABLE' }, 'REPORT_ENTITLEMENTS_UNAVAILABLE'],
      [{ sourceError: 'REPORT_CONFIRMATION_REQUIRED' }, 'REPORT_CONFIRMATION_REQUIRED'],
      [{ sourceError: 'REPORT_SOURCE_CONFLICT' }, 'REPORT_SOURCE_CONFLICT'], [{ shortQualified: 0 }, 'REPORT_BENCHMARKS_REQUIRED']] as const) {
      const r = harness(over);
      await runReportTurn(r.deps, input, r.emit);
      expect(r.events).toEqual([{ type: 'error', code }]);
      expect(r.names()).toEqual([]);
    }
    // A round of another module than the quoted one is refused before opening.
    const other = harness();
    await runReportTurn(other.deps, { ...input, moduleId: uuid(44) }, other.emit);
    expect(other.events).toEqual([{ type: 'error', code: 'REPORT_SOURCE_CONFLICT' }]);
  });
});
