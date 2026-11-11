/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStop } from './call';
import type { ChatDeps } from './chat';
import { runPlanTurn, type PlanInput } from './plan';
import { handlePlanRead, parsePlan } from './planHttp';
import type { ReportHttpDeps } from './reportHttp';
import type { TurnEvent } from './sse';
import { logger } from '../../lib/logger';

/*
 * CORE-PATH-V2 V2-10b, Node side of kind=plan with the database, the catalog and the provider faked (the database rules are
 * packages/db/tests/turn-core/plan-cases.mjs): the frozen numbers, the prompt, how each outcome closes, and the read.
 */
const h = vi.hoisted(() => ({ request: [] as Array<{ context: Record<string, unknown>; phase: string }>, call: vi.fn(), runtime: vi.fn(),
  chatQuote: vi.fn(), module: vi.fn() }));
vi.mock('./chat', async original => ({ ...await original<object>(), readCoreConfig: () => ({ enabled: true, decisionUpperUsd: '0.01',
  stopLoss: { limitUsd: 100, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } }) }));
vi.mock('./admission/admissionConfiguration', async original => ({ ...await original<object>(),
  readAdmissionConfiguration: async () => ({ data: [{ key: 'billing_payg_start_thresholds', value: { version: 'v1',
    thresholds: [{ model: 'anthropic/claude-sonnet-5.5', purpose: 'ordinary', credits: 12 }, { model: 'anthropic/claude-sonnet-5.5', purpose: 'skill', credits: 99 }] } }],
    error: null }), readAdmissionModule: h.module }));
vi.mock('./settings/purposeBudgets', async original => ({ ...await original<object>(), readPurposeBudgets: async () => null }));
vi.mock('./admission/newWorkGate', async original => ({ ...await original<object>(), readAdmissionSettings: async () => ({ ok: true, identityGuard: false }) }));
vi.mock('./reportSkill', async original => ({ ...await original<object>(), reportSkillText: async () => 'SKILL TEXT' }));
vi.mock('./agent/context', async original => ({ ...await original<object>(), assertRuntimeRequestCapacity: () => undefined }));
vi.mock('./provider/providerRequest', async original => ({ ...await original<object>(),
  openRouterRequestBody: (_body: string, options: { context: Record<string, unknown>; phase: string }) => { h.request.push(options); return 'REQUEST'; } }));
vi.mock('./provider/openRouterAdapter', async original => ({ ...await original<object>(), openRouterAdapter: () => ({}) }));
vi.mock('./call', async original => ({ ...await original<object>(), modelCall: h.call }));
vi.mock('./agent/runner', async original => ({ ...await original<object>(), runRuntime: h.runtime }));
vi.mock('./quote', async original => ({ ...await original<object>(), chatQuote: h.chatQuote }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input: PlanInput = { actorId: 'actor', sessionId: uuid(1), requestId: uuid(2), moduleId: uuid(4), stepId: 's', text: 'one week on tiktok' };
const quote = { pricing: { version: 'nominal-v1' }, modelId: uuid(20), model: 'anthropic/claude-sonnet-5.5', q: '100', multiplier: '6',
  upperUsd: '0.3', outputLimit: 32768, inputLimit: 90000, reasoning: { parameter: 'none' },
  providerLimits: { providerSlug: 'anthropic', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15',
    requestUsd: '0', cacheWriteUsdPerMillion: '3.75' }, identity: { account: 'test' }, credential: async () => 'KEY', concurrency: 4 };
const context = { draftId: uuid(5), projectId: uuid(6), roundId: uuid(3), moduleId: input.moduleId, skillId: uuid(7), revisionId: uuid(8),
  packageHash: 'b'.repeat(64), resources: ['plan.md'], work: { roundId: uuid(3), steps: { s: { body: 'CONFIRMED' } } } };
const PLAN = JSON.stringify([{ id: uuid(9), platform: 'tiktok', account: 'me', title: 'T', brief: 'B', day: '2026-11-02' }]);

function harness(over: { open?: () => unknown; openError?: string; source?: unknown; gate?: { message?: unknown; calls?: unknown };
  /** A turn_close the database refuses (its error text), by the arguments it was called with. */
  closeError?: (args: Record<string, unknown>) => string | undefined } = {}) {
  const rpc: Array<[string, Record<string, unknown>]> = [];
  const respond = async (name: string, args: Record<string, unknown>) => {
    rpc.push([name, args]);
    if (name === 'mentor_source_check') return { data: over.source ?? { allowed: true, businessContext: { name: 'B' }, sourceDrafts: [] }, error: null };
    if (name === 'turn_open' && over.openError) return { data: null, error: { code: 'P0001', message: over.openError, details: null } };
    if (name === 'turn_open') return { data: over.open?.() ?? { turnId: 9, state: 'running', replay: false, reservedCredits: 30,
      reservedUsd: 0.3, history: [{ seq: 1, role: 'user', content: 'earlier', contentHash: 'a'.repeat(64) }], kindContext: context }, error: null };
    const refused = name === 'turn_close' ? over.closeError?.(args) : undefined;
    if (refused) return { data: null, error: { code: 'P0001', message: refused, details: null } };
    if (name === 'turn_close') return { data: { turnId: 9, closeKind: args.p_close_kind, chargedCredits: args.p_delivered ? 7 : 0,
      absorbedCredits: 0, settlement: 'done', replay: false }, error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  };
  const client = { rpc: respond, from: () => { throw new Error('no table reads'); } };
  const deps = { admin: {}, clients: { write: client, read: client }, slots: {},
    newWork: { message: async () => over.gate?.message ?? { ok: true }, calls: async () => over.gate?.calls ?? { ok: true } } } as unknown as ChatDeps;
  const events: TurnEvent[] = [];
  return { rpc, deps, events, emit: (e: TurnEvent) => events.push(e), names: () => rpc.map(([n]) => n),
    args: (name: string) => rpc.find(([n]) => n === name)![1] };
}
type Run = { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void; instructions: string; input: string };
const runs = (text: string) => { h.call.mockResolvedValue('{}'); h.runtime.mockImplementation(async (o: Run) => { await o.exchange(1, '{}'); o.onText(text); return text; }); };

describe('kind=plan on the turn core (CORE-PATH-V2 V2-10b)', () => {
  beforeEach(() => { h.request.length = 0; h.call.mockReset(); h.runtime.mockReset(); h.chatQuote.mockReset(); h.chatQuote.mockResolvedValue(quote);
    h.module.mockReset(); h.module.mockResolvedValue({ error: null, data: { id: input.moduleId, active: true, model_id: uuid(20) } }); });

  it('one read then five writes at most; metered, the ordinary start threshold, the source frozen for turn_open to check', async () => {
    const t = harness(); runs(PLAN);
    await runPlanTurn(t.deps, input, t.emit);
    const open = t.args('turn_open'), policy = open.p_policy as Record<string, unknown>;
    expect(open.p_kind).toBe('plan');
    expect(policy).toMatchObject({ gCredits: 180, minCredits: 12, historyItems: 100, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 },
      plan: { moduleId: input.moduleId, stepId: 's', requestId: input.requestId, sourceChecked: true, sourceDrafts: [] } });
    expect(policy).not.toHaveProperty('fixedCredits');
    expect(h.chatQuote.mock.calls[0]![1]).toMatchObject({ modelId: uuid(20), use: { phase: 'skill', purpose: 'interactive' } });
    expect(t.names()).toEqual(['mentor_source_check', 'turn_open', 'turn_close']);
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true, p_messages: [],
      p_kind_result: { body: PLAN, roundId: context.roundId } });
    expect(t.events.at(-1)).toMatchObject({ type: 'result', turnId: 9, body: PLAN, chargedCredits: 7 });
  });

  it('builds the prompt from the Skill, the plan rules, the work and the constraints, without tools', async () => {
    const t = harness(); runs(PLAN);
    await runPlanTurn(t.deps, input, t.emit);
    const run = h.runtime.mock.calls[0]![0] as Run & { maxTurns: number; tools: unknown[] };
    expect(run.instructions.startsWith('SKILL TEXT\nCreate a first-week content plan candidate')).toBe(true);
    expect(run.instructions).toContain('Current workflow step: s');
    const current = JSON.parse(run.input);
    expect(current.userRequest).toBe(input.text);
    expect(current.scopeMaterial.content).toMatchObject({ brief: 'plan:s', roundId: context.roundId,
      work: { steps: { s: { body: 'CONFIRMED' } }, businessContext: { name: 'B' } } });
    expect([run.maxTurns, run.tools]).toEqual([1, []]);
    expect(h.request[0]!.context).toMatchObject({ tools: [], network: 'deny' });
  });

  it('a body that is no usable plan is delivered and charged, as the old path', async () => {
    const t = harness(); runs('sorry, no plan');
    await runPlanTurn(t.deps, input, t.emit);
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true, p_kind_result: { body: 'sorry, no plan' } });
    expect(parsePlan('sorry, no plan')).toBeNull();
  });

  it('refuses before anything opens: paused, a module not offered, a denied source, no threshold for the model', async () => {
    const paused = harness({ gate: { message: { ok: false, reason: 'paused' } } });
    await runPlanTurn(paused.deps, input, paused.emit);
    expect(paused.events).toEqual([{ type: 'error', code: 'TURN_NEW_CALLS_PAUSED' }]);
    h.module.mockResolvedValueOnce({ error: null, data: { active: false } });
    const off = harness();
    await runPlanTurn(off.deps, input, off.emit);
    expect(off.events).toEqual([{ type: 'error', code: 'TURN_PLAN_DENIED' }]);
    const denied = harness({ source: { allowed: false } });
    await runPlanTurn(denied.deps, input, denied.emit);
    expect(denied.events).toEqual([{ type: 'error', code: 'TURN_PLAN_DENIED' }]);
    h.chatQuote.mockResolvedValueOnce({ ...quote, model: 'other/model' });
    const none = harness();
    await runPlanTurn(none.deps, input, none.emit);
    expect(none.events).toEqual([{ type: 'error', code: 'TURN_START_THRESHOLD_UNCONFIGURED' }]);
    for (const t of [paused, off, denied, none]) expect(t.names()).not.toContain('turn_open');
  });

  it('keeps a refusal from turn_open: archived business, session busy, no credits; a replay never runs the model', async () => {
    for (const code of ['OPC_BUSINESS_ARCHIVED', 'TURN_SESSION_BUSY', 'TURN_INSUFFICIENT_CREDITS', 'TURN_PLAN_REQUEST_CONFLICT']) {
      const t = harness({ openError: code });
      await runPlanTurn(t.deps, input, t.emit);
      expect(t.events).toEqual([{ type: 'error', code }]);
    }
    const r = harness({ open: () => ({ turnId: 9, state: 'closed', replay: true, reservedCredits: 30, reservedUsd: 0.3, history: [], kindContext: context }) });
    await runPlanTurn(r.deps, input, r.emit);
    expect(r.names()).toEqual(['mentor_source_check', 'turn_open']);
    expect(r.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: 9 });
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it('a failure closes refunded and saves nothing; an unknown outcome closes interrupted for recovery; a limit refuses the paid call', async () => {
    const t = harness(); h.runtime.mockRejectedValue(new Error('boom'));
    await runPlanTurn(t.deps, input, t.emit);
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true, p_delivered: false, p_kind_result: null });
    const u = harness(); h.runtime.mockRejectedValue(new TurnStop('TURN_CALL_UNKNOWN'));
    await runPlanTurn(u.deps, input, u.emit);
    expect(u.args('turn_close')).toMatchObject({ p_close_kind: 'interrupted', p_delivered: false });
    expect(u.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_CALL_UNKNOWN' });
    const l = harness({ gate: { calls: { ok: false, reason: 'call_limited' } } });
    h.runtime.mockImplementation(async (o: Run) => o.exchange(1, '{}'));
    await runPlanTurn(l.deps, input, l.emit);
    expect(h.call).not.toHaveBeenCalled();
    expect(l.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true });
  });

  // CHAT_NATIVE_OUTPUT_PLAN 4.2: a plan is one JSON document, so a call cut off part-way saves nothing of it (never a broken document).
  it('a plan cut off part-way saves nothing and closes interrupted, whatever was streamed', async () => {
    const t = harness(); h.call.mockResolvedValue('{}');
    h.runtime.mockImplementation(async (o: Run) => { o.onText('[{"id":"half'); throw new TurnStop('TURN_CALL_UNKNOWN'); });
    await runPlanTurn(t.deps, input, t.emit);
    const closes = t.rpc.filter(([name]) => name === 'turn_close').map(([, args]) => args);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ p_close_kind: 'interrupted', p_delivered: false, p_kind_result: null });
    expect(t.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_CALL_UNKNOWN' });
  });

  // Deep review 2026-11-11, findings 2 and 9 (Owner 2026-11-11: a turn whose answer was not saved does not charge the user). The
  // turn is refunded like any failure that saved nothing, and it is an error in the log: it must stay rare.
  it('a closing write that fails after the whole plan was streamed refunds the turn and is logged as an error', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const t = harness({ closeError: args => args.p_close_kind === 'completed' ? 'connection reset' : undefined }); runs(PLAN);
      await runPlanTurn(t.deps, input, t.emit);
      const closes = t.rpc.filter(([name]) => name === 'turn_close').map(([, args]) => args);
      expect(closes).toHaveLength(2);
      expect(closes[0]).toMatchObject({ p_close_kind: 'completed', p_delivered: true });
      expect(closes[1]).toMatchObject({ p_close_kind: 'failed', p_refund_all: true, p_delivered: false,
        p_failure_code: 'turn_database_unavailable', p_kind_result: null });
      expect(t.events.map(e => e.type)).toEqual(['opened', 'text', 'error']);
      expect(t.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_DATABASE_UNAVAILABLE', turnId: 9 });
      expect(logged).toHaveBeenCalledExactlyOnceWith('ai', 'turn_answer_unsaved', { kind: 'plan', turnId: 9, code: 'TURN_DATABASE_UNAVAILABLE' });
      // A failure before the answer was complete is an ordinary failed turn: refunded, not this error.
      logged.mockClear();
      const early = harness(); h.runtime.mockRejectedValue(new Error('boom'));
      await runPlanTurn(early.deps, input, early.emit);
      expect(early.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true });
      expect(logged).not.toHaveBeenCalledWith('ai', 'turn_answer_unsaved', expect.anything());
    } finally { logged.mockRestore(); }
  });
});

describe('GET /api/turn/plan', () => {
  const url = `https://app.test/api/turn/plan?sessionId=${uuid(1)}&requestId=${uuid(2)}`;
  const deps = (answer: { data?: unknown; error?: { message: string } }, over: Partial<ReportHttpDeps> = {}) => {
    const client = { rpc: async () => ({ data: answer.data ?? null, error: answer.error ?? null }) };
    return { authenticate: async () => 'actor', databaseHost: { declared: 'db', actual: 'db' }, clients: { write: client, read: client }, ...over } as unknown as ReportHttpDeps;
  };
  const turn = { turnId: 9, state: 'closed', closeKind: 'completed', delivered: true, chargedCredits: 7, settlement: 'done', body: PLAN,
    sourceRoundId: uuid(3), sourceVersionId: uuid(10) };
  const answer = async (res: Response) => [res.status, await res.json()];

  it('reads the plan, marks an unusable body invalid, answers null for a request with no turn', async () => {
    expect(await answer(await handlePlanRead(new Request(url), deps({ data: turn })))).toEqual([200, { plan: { turnId: 9, state: 'closed',
      closeKind: 'completed', chargedCredits: 7, settlement: 'done', valid: true, items: JSON.parse(PLAN), sourceRoundId: uuid(3), sourceVersionId: uuid(10) } }]);
    const [, bad] = await answer(await handlePlanRead(new Request(url), deps({ data: { ...turn, body: 'no' } })));
    expect(bad.plan).toMatchObject({ valid: false, items: null, chargedCredits: 7 });
    expect(await answer(await handlePlanRead(new Request(url), deps({})))).toEqual([200, { plan: null }]);
  });

  it('refuses: bad shape, no account, wrong database, someone else\'s conversation; database text never leaks', async () => {
    expect((await handlePlanRead(new Request('https://app.test/api/turn/plan?sessionId=x'), deps({}))).status).toBe(400);
    expect((await handlePlanRead(new Request(url), deps({}, { authenticate: async () => null }))).status).toBe(401);
    expect((await handlePlanRead(new Request(url), deps({}, { databaseHost: { declared: 'a', actual: 'b' } }))).status).toBe(503);
    expect(await answer(await handlePlanRead(new Request(url), deps({ error: { message: 'TURN_SESSION_DENIED at line 3' } })))).toEqual([404, { error: 'TURN_SESSION_DENIED' }]);
    expect(await answer(await handlePlanRead(new Request(url), deps({ error: { message: 'TURN_PLAN_DENIED' } })))).toEqual([404, { error: 'TURN_PLAN_DENIED' }]);
    expect(await answer(await handlePlanRead(new Request(url), deps({ error: { message: 'connection reset' } })))).toEqual([503, { error: 'TURN_DATABASE_UNAVAILABLE' }]);
  });
});
