/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStop } from './call';
import type { ChatDeps } from './chat';
import { FREE_MINUTES_INSTRUCTIONS, minutesTranscript, runMinutesTurn, TOPIC_MINUTES_INSTRUCTIONS } from './minutes';
import type { TurnEvent } from './sse';

/*
 * CONTENT-CONVERSATION-2, Node side of kind=minutes with the database, the catalog and the provider faked (the database rules are
 * packages/db/tests/turn-core/minutes-cases.mjs): the frozen numbers, the prompt, and how each outcome closes.
 */
const h = vi.hoisted(() => ({ request: [] as Array<{ context: Record<string, unknown>; phase: string }>, call: vi.fn(), runtime: vi.fn(),
  chatQuote: vi.fn() }));
vi.mock('./chat', async original => ({ ...await original<object>(), readCoreConfig: () => ({ enabled: true, decisionUpperUsd: '0.01',
  stopLoss: { limitUsd: 100, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } }) }));
vi.mock('./admission/admissionConfiguration', async original => ({ ...await original<object>(),
  readAdmissionConfiguration: async () => ({ data: [
    { key: 'v3_summary_model_id', value: '00000000-0000-4000-8000-000000000020' },
    { key: 'billing_payg_start_thresholds', value: { version: 'v1', thresholds: [
      { model: 'openai/gpt-6-luna', purpose: 'attached_organizer', credits: 15 }, { model: 'openai/gpt-6-luna', purpose: 'skill', credits: 99 }] } }],
  error: null }) }));
vi.mock('./settings/purposeBudgets', async original => ({ ...await original<object>(), readPurposeBudgets: async () => null }));
vi.mock('./admission/newWorkGate', async original => ({ ...await original<object>(),
  readAdmissionSettings: async () => ({ ok: true, identityGuard: false }) }));
vi.mock('./agent/context', async original => ({ ...await original<object>(), assertRuntimeRequestCapacity: () => undefined }));
vi.mock('./provider/providerRequest', async original => ({ ...await original<object>(),
  openRouterRequestBody: (_body: string, options: { context: Record<string, unknown>; phase: string }) => { h.request.push(options); return 'REQUEST'; } }));
vi.mock('./provider/openRouterAdapter', async original => ({ ...await original<object>(), openRouterAdapter: () => ({}) }));
vi.mock('./call', async original => ({ ...await original<object>(), modelCall: h.call }));
vi.mock('./agent/runner', async original => ({ ...await original<object>(), runRuntime: h.runtime }));
vi.mock('./quote', async original => ({ ...await original<object>(), chatQuote: h.chatQuote }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = { actorId: 'actor', sessionId: uuid(1), requestId: uuid(2) };
const quote = { pricing: { version: 'nominal-v1' }, modelId: uuid(20), model: 'openai/gpt-6-luna', q: '100', multiplier: '6',
  upperUsd: '0.05', outputLimit: 4000, inputLimit: 112000, reasoning: { parameter: 'none' },
  providerLimits: { providerSlug: 'openai', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0' },
  identity: { account: 'test' }, credential: async () => 'KEY', concurrency: 4 };
const hash = 'a'.repeat(64);
const HISTORY = [{ seq: 1, role: 'user', content: '我想做露营装备测评', contentHash: hash },
  { seq: 2, role: 'assistant', content: '可以先从帐篷开始', contentHash: hash }];

function harness(over: { replay?: boolean; openError?: string; erased?: boolean; history?: unknown[]; work?: unknown } = {}) {
  const rpc: Array<[string, Record<string, unknown>]> = [];
  const respond = async (name: string, args: Record<string, unknown>) => {
    rpc.push([name, args]);
    if (name === 'opc_work_check') return { data: { work: over.work ?? null }, error: null };
    if (name === 'turn_open' && over.openError) return { data: null, error: { code: 'P0001', message: over.openError, details: null } };
    if (name === 'turn_open') return { data: { turnId: 9, state: 'running', replay: over.replay ?? false, reservedCredits: 30, reservedUsd: 0.05,
      history: over.history ?? HISTORY, replyLanguage: null }, error: null };
    if (name === 'turn_close') return { data: { turnId: 9, closeKind: over.erased ? 'erased' : args.p_close_kind, chargedCredits: args.p_delivered ? 7 : 0,
      absorbedCredits: 0, settlement: 'done', replay: false }, error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  };
  const client = { rpc: respond, from: () => { throw new Error('no table reads'); } };
  const deps = { admin: {}, clients: { write: client, read: client }, slots: {},
    newWork: { message: async () => ({ ok: true }), calls: async () => ({ ok: true }) } } as unknown as ChatDeps;
  const events: TurnEvent[] = [];
  return { rpc, deps, events, emit: (e: TurnEvent) => { events.push(e); }, names: () => rpc.map(([n]) => n),
    args: (name: string) => rpc.find(([n]) => n === name)![1] };
}
type Run = { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void; instructions: string; input: string };
const runs = (text: string) => {
  h.call.mockResolvedValue('{}');
  h.runtime.mockImplementation(async (o: Run) => { await o.exchange(1, '{}'); o.onText(text); return text; });
};

describe('kind=minutes on the turn core (CONTENT-CONVERSATION-2)', () => {
  beforeEach(() => { h.request.length = 0; h.call.mockReset(); h.runtime.mockReset(); h.chatQuote.mockReset(); h.chatQuote.mockResolvedValue(quote); });

  it('opens on the conversation, freezes one organizer call and keeps the minutes in the close, not as a message', async () => {
    const t = harness(); runs('## 讨论了什么\n- 露营装备测评');
    await runMinutesTurn(t.deps, input, t.emit);
    expect(t.names()).toEqual(['opc_work_check', 'turn_open', 'turn_close']);
    const open = t.args('turn_open'), policy = open.p_policy as Record<string, unknown>;
    expect(open).toMatchObject({ p_kind: 'minutes', p_session_id: input.sessionId, p_request_id: input.requestId });
    expect(policy).toMatchObject({ gCredits: 30, minCredits: 15, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 } });
    expect(policy).not.toHaveProperty('holdCredits');
    expect(h.chatQuote.mock.calls[0]![1]).toMatchObject({ modelId: uuid(20), use: { phase: 'attached_organizer', purpose: 'organize', outputCap: 4000 } });
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true, p_messages: [],
      p_kind_result: { minutes: '## 讨论了什么\n- 露营装备测评' } });
    expect(t.events.at(-1)).toMatchObject({ type: 'result', turnId: 9, chargedCredits: 7 });
  });

  it('sends the conversation as data with the meeting format; a topic window gets its brief and the topic format', async () => {
    const free = harness(); runs('纪要');
    await runMinutesTurn(free.deps, input, free.emit);
    const run = h.runtime.mock.calls[0]![0] as Run & { maxTurns: number; tools: unknown[]; readSessionHistory: boolean };
    expect(run.instructions).toContain('minutes of the conversation');
    expect(run.input).toContain('用户：我想做露营装备测评');
    expect(run.input).toContain('AI：可以先从帐篷开始');
    expect(run).toMatchObject({ maxTurns: 1, tools: [], readSessionHistory: false });
    h.runtime.mockReset();
    const topic = harness({ work: { moduleId: uuid(5), skillId: uuid(6), revisionId: uuid(7), brief: 'TOPIC_BRIEF', material: null, videoPackage: false,
      materialRevision: 1, materialHash: 'f', sources: [] } }); runs('纪要');
    await runMinutesTurn(topic.deps, input, topic.emit);
    const second = h.runtime.mock.calls[0]![0] as Run;
    expect(second.instructions).toContain('one content topic');
    expect(second.input).toContain('TOPIC_BRIEF');
  });

  it('a conversation with nothing in it closes refunded and calls no model', async () => {
    const t = harness({ history: [] }); runs('x');
    await runMinutesTurn(t.deps, input, t.emit);
    expect(h.runtime).not.toHaveBeenCalled();
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true, p_failure_code: 'minutes_empty' });
    expect(t.events.at(-1)).toMatchObject({ type: 'error', code: 'MINUTES_EMPTY' });
  });

  it('a repeated request runs nothing again; an empty answer is refunded; an unknown outcome waits for recovery', async () => {
    const replay = harness({ replay: true }); runs('x');
    await runMinutesTurn(replay.deps, input, replay.emit);
    expect(replay.names()).toEqual(['opc_work_check', 'turn_open']);
    expect(h.runtime).not.toHaveBeenCalled();
    const empty = harness(); runs('   ');
    await runMinutesTurn(empty.deps, input, empty.emit);
    expect(empty.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true, p_delivered: false });
    const unknown = harness(); h.runtime.mockImplementation(async () => { throw new TurnStop('TURN_CALL_UNKNOWN'); });
    await runMinutesTurn(unknown.deps, input, unknown.emit);
    expect(unknown.args('turn_close')).toMatchObject({ p_close_kind: 'interrupted', p_refund_all: false });
    const paused = harness(); h.runtime.mockImplementation(async () => { throw new TurnStop('TURN_PAUSED_FOR_CREDITS'); });
    await runMinutesTurn(paused.deps, input, paused.emit);
    expect(paused.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true });
  });

  it('keeps the newest messages that fit, oldest first', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      ({ seq: i + 1, role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'm' + i, contentHash: hash }));
    const all = minutesTranscript(many, 10_000);
    expect(all.messages).toBe(5);
    expect(all.text.startsWith('用户：m0')).toBe(true);
    const two = minutesTranscript(many, Buffer.byteLength('用户：m4\n\nAI：m3\n\n'));
    expect(two).toEqual({ text: 'AI：m3\n\n用户：m4', messages: 2 });
  });

  // Validation of #2009: Chinese minutes once came with English headings copied from the format.
  it('asks for the headings in the reply language and names the Chinese ones', () => {
    for (const text of [FREE_MINUTES_INSTRUCTIONS, TOPIC_MINUTES_INSTRUCTIONS]) expect(text).toContain('never copy the English heading names');
    expect(FREE_MINUTES_INSTRUCTIONS).toContain('讨论了什么、定了什么、还没定的、下一步');
    expect(TOPIC_MINUTES_INSTRUCTIONS).toContain('简报更新、稿件已定的部分、还没定的、下一步');
  });
});
