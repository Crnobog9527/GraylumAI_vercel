/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStop } from './call';
import type { ChatDeps } from './chat';
import type { TurnEvent } from './sse';
import { runTopicTurn, type TopicInput } from './topic';
import { handleTopicTurn, type TopicHttpDeps } from './topicHttp';

/*
 * CORE-PATH-V2 V2-10b, Node side of a topic turn with the database, the catalog and the provider faked (the database rules are
 * packages/db/tests/turn-core/topic-cases.mjs): the read before opening, the frozen numbers, the prompt and how each outcome closes.
 */
const h = vi.hoisted(() => ({ call: vi.fn(), runtime: vi.fn(), chatQuote: vi.fn(), module: vi.fn() }));
vi.mock('./chat', async original => ({ ...await original<object>(), readCoreConfig: () => ({ enabled: true, decisionUpperUsd: '0.01',
  stopLoss: { limitUsd: 100, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } }) }));
vi.mock('./admission/admissionConfiguration', async original => ({ ...await original<object>(),
  readAdmissionConfiguration: async () => ({ data: [{ key: 'billing_payg_start_thresholds', value: { version: 'v1',
    thresholds: [{ model: 'anthropic/claude-sonnet-5.5', purpose: 'ordinary', credits: 12 }] } }], error: null }), readAdmissionModule: h.module }));
vi.mock('./settings/purposeBudgets', async original => ({ ...await original<object>(), readPurposeBudgets: async () => null }));
vi.mock('./admission/newWorkGate', async original => ({ ...await original<object>(), readAdmissionSettings: async () => ({ ok: true, identityGuard: false }) }));
vi.mock('./reportSkill', async original => ({ ...await original<object>(), reportSkillText: async () => 'SKILL TEXT' }));
vi.mock('./agent/context', async original => ({ ...await original<object>(), assertRuntimeRequestCapacity: () => undefined }));
vi.mock('./provider/providerRequest', async original => ({ ...await original<object>(), openRouterRequestBody: () => 'REQUEST' }));
vi.mock('./provider/openRouterAdapter', async original => ({ ...await original<object>(), openRouterAdapter: () => ({}) }));
vi.mock('./call', async original => ({ ...await original<object>(), modelCall: h.call }));
vi.mock('./agent/runner', async original => ({ ...await original<object>(), runRuntime: h.runtime }));
vi.mock('./quote', async original => ({ ...await original<object>(), chatQuote: h.chatQuote }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input: TopicInput = { actorId: 'actor', draftId: uuid(1), requestId: uuid(2), text: 'topics for tiktok' };
const quote = { pricing: { version: 'nominal-v1' }, modelId: uuid(20), model: 'anthropic/claude-sonnet-5.5', q: '100', multiplier: '6',
  upperUsd: '0.3', outputLimit: 32768, inputLimit: 90000, reasoning: { parameter: 'none' },
  providerLimits: { providerSlug: 'anthropic', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15',
    requestUsd: '0', cacheWriteUsdPerMillion: '3.75' }, identity: { account: 'test' }, credential: async () => 'KEY', concurrency: 4 };
const workspace = { sessionId: uuid(3), moduleId: uuid(4), skillId: uuid(5), revisionId: uuid(6), packageHash: 'b'.repeat(64),
  resources: ['plan.md'], sourceVersionId: uuid(7), material: { sessionId: uuid(3), revision: 1, hash: 'f', content: { material: 'CONFIRMED' } } };

function harness(over: { source?: { data?: unknown; error?: { message: string } }; openError?: string; open?: () => unknown; gate?: { message?: unknown; calls?: unknown } } = {}) {
  const rpc: Array<[string, Record<string, unknown>]> = [];
  const respond = async (name: string, args: Record<string, unknown>) => {
    rpc.push([name, args]);
    if (name === 'topic_turn_source') return { data: over.source?.data ?? (over.source?.error ? null : workspace), error: over.source?.error ?? null };
    if (name === 'turn_open' && over.openError) return { data: null, error: { code: 'P0001', message: over.openError, details: null } };
    if (name === 'turn_open') return { data: over.open?.() ?? { turnId: 9, state: 'running', replay: false, reservedCredits: 30, reservedUsd: 0.3,
      history: [], positioning: { positioned: true, refusals24h: 0 } }, error: null };
    if (name === 'turn_close') return { data: { turnId: 9, closeKind: args.p_close_kind, chargedCredits: args.p_delivered ? 7 : 0,
      absorbedCredits: 0, settlement: 'done', replay: false }, error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  };
  const client = { rpc: respond, from: () => { throw new Error('no table reads'); } };
  const deps = { admin: {}, clients: { write: client, read: client }, slots: {},
    newWork: { message: async () => over.gate?.message ?? { ok: true }, calls: async () => over.gate?.calls ?? { ok: true } } } as unknown as ChatDeps;
  const events: TurnEvent[] = [];
  return { deps, events, emit: (e: TurnEvent) => events.push(e), names: () => rpc.map(([n]) => n), args: (name: string) => rpc.find(([n]) => n === name)![1] };
}
type Run = { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void; instructions: string; input: string; tools: unknown[]; maxTurns: number };
const runs = (text: string) => { h.call.mockResolvedValue('{}'); h.runtime.mockImplementation(async (o: Run) => { await o.exchange(1, '{}'); o.onText(text); return text; }); };

describe('a topic turn on kind=chat (CORE-PATH-V2 V2-10b)', () => {
  beforeEach(() => { h.call.mockReset(); h.runtime.mockReset(); h.chatQuote.mockReset(); h.chatQuote.mockResolvedValue(quote); h.module.mockReset();
    h.module.mockResolvedValue({ error: null, data: { id: workspace.moduleId, active: true, model_id: uuid(20) } }); });

  it('reads the workspace first, opens a metered chat turn in its conversation and saves both messages', async () => {
    const t = harness(); runs('Topics');
    await runTopicTurn(t.deps, input, t.emit);
    expect(t.names()).toEqual(['topic_turn_source', 'turn_open', 'turn_close']);
    expect(t.args('topic_turn_source')).toEqual({ p_actor_id: 'actor', p_draft_id: input.draftId, p_request_id: input.requestId });
    expect(t.args('turn_open')).toMatchObject({ p_kind: 'chat', p_session_id: workspace.sessionId, p_request_id: input.requestId,
      p_policy: { topic: true, minCredits: 12, gCredits: 180, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 } } });
    expect(t.args('turn_open').p_policy).not.toHaveProperty('fixedCredits');
    expect(h.chatQuote.mock.calls[0]![1]).toMatchObject({ modelId: uuid(20) });
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true,
      p_messages: [{ role: 'user', content: input.text }, { role: 'assistant', content: 'Topics' }] });
    expect(t.events.at(-1)).toMatchObject({ type: 'result', turnId: 9, body: 'Topics', chargedCredits: 7 });
  });

  it('builds the prompt from the Skill, the workspace rules and the frozen material, without tools or a positioning check', async () => {
    const t = harness(); runs('Topics');
    await runTopicTurn(t.deps, input, t.emit);
    const run = h.runtime.mock.calls[0]![0] as Run;
    expect(run.instructions.startsWith("SKILL TEXT\nThis turn runs inside the user's first-week topic workspace")).toBe(true);
    expect(run.instructions).toContain('YYYY-MM-DD');
    expect(String(run.input)).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
    expect(JSON.parse(run.input).userRequest).toContain(input.text);
    expect(JSON.parse(run.input)).toMatchObject({ scopeMaterial: { revision: 1, content: { material: 'CONFIRMED' } } });
    expect([run.maxTurns, run.tools]).toEqual([1, []]);
  });

  it('refuses before anything opens, keeping the workspace\'s own code and never database text', async () => {
    for (const [message, code] of [['OPC_BUSINESS_ARCHIVED', 'OPC_BUSINESS_ARCHIVED'], ['OPC_TOPIC_UNBOUND', 'OPC_TOPIC_UNBOUND'],
      ['OPC_TOPIC_SOURCE_REVOKED at line 3', 'OPC_TOPIC_SOURCE_REVOKED'], ['OPC_REQUEST_CONFLICT', 'OPC_REQUEST_CONFLICT'],
      ['CONTENT_ERASED', 'CONTENT_ERASED'], ['connection reset', 'TURN_OPEN_FAILED']] as const) {
      const t = harness({ source: { error: { message } } });
      await runTopicTurn(t.deps, input, t.emit);
      expect(t.events).toEqual([{ type: 'error', code }]);
      expect(t.names()).toEqual(['topic_turn_source']);
    }
    const paused = harness({ gate: { message: { ok: false, reason: 'paused' } } });
    await runTopicTurn(paused.deps, input, paused.emit);
    expect(paused.events).toEqual([{ type: 'error', code: 'TURN_NEW_CALLS_PAUSED' }]);
    expect(paused.names()).toEqual([]);
    h.module.mockResolvedValueOnce({ error: null, data: { active: false } });
    const off = harness();
    await runTopicTurn(off.deps, input, off.emit);
    expect(off.names()).not.toContain('turn_open');
  });

  it('keeps a refusal from turn_open; a replay never runs the model; failures save nothing', async () => {
    for (const code of ['TURN_SESSION_BUSY', 'TURN_INSUFFICIENT_CREDITS', 'STOP_LOSS_REACHED']) {
      const t = harness({ openError: code });
      await runTopicTurn(t.deps, input, t.emit);
      expect(t.events).toEqual([{ type: 'error', code }]);
    }
    const r = harness({ open: () => ({ turnId: 9, state: 'closed', replay: true, reservedCredits: 30, reservedUsd: 0.3, history: [] }) });
    await runTopicTurn(r.deps, input, r.emit);
    expect(r.events.at(-1)).toMatchObject({ type: 'error', code: 'TURN_REQUEST_REPLAYED', turnId: 9 });
    expect(h.runtime).not.toHaveBeenCalled();
    const f = harness(); h.runtime.mockRejectedValue(new Error('boom'));
    await runTopicTurn(f.deps, input, f.emit);
    expect(f.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true, p_delivered: false, p_messages: [] });
    const u = harness(); h.runtime.mockRejectedValue(new TurnStop('TURN_CALL_UNKNOWN'));
    await runTopicTurn(u.deps, input, u.emit);
    expect(u.args('turn_close')).toMatchObject({ p_close_kind: 'interrupted', p_delivered: false });
  });
});

describe('POST /api/turn/topic', () => {
  const post = (body: unknown) => new Request('https://app.test/api/turn/topic', { method: 'POST', body: JSON.stringify(body) });
  const good = { draftId: input.draftId, requestId: input.requestId, input: input.text };
  const deps = (over: Partial<TopicHttpDeps> = {}) => ({ authenticate: async () => 'actor', rateLimited: async () => false,
    databaseHost: { declared: 'db', actual: 'db' }, chat: harness({ source: { error: { message: 'OPC_TOPIC_UNBOUND' } } }).deps, ...over }) as TopicHttpDeps;

  it('refuses before streaming: shape, wrong database, no account, the rate limit, a limiter that cannot answer', async () => {
    expect((await handleTopicTurn(post({ ...good, extra: 1 }), deps())).status).toBe(400);
    expect((await handleTopicTurn(post(good), deps({ databaseHost: { declared: 'a', actual: 'b' } }))).status).toBe(503);
    expect((await handleTopicTurn(post(good), deps({ authenticate: async () => null }))).status).toBe(401);
    expect((await handleTopicTurn(post(good), deps({ rateLimited: async () => true }))).status).toBe(429);
    expect((await handleTopicTurn(post(good), deps({ rateLimited: async () => { throw new Error('down'); } }))).status).toBe(429);
  });

  it('answers one event stream', async () => {
    const res = await handleTopicTurn(post(good), deps());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('OPC_TOPIC_UNBOUND');
  });
});
