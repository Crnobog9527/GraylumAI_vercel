/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStop } from './call';
import type { ChatDeps } from './chat';
import { runVoiceTurn } from './voice';

/*
 * CORE-PATH-V2 V2-12 B7, Node side of kind=voice with the database, the catalog and the provider faked (the database rules are
 * packages/db/tests/turn-core/voice-cases.mjs): the frozen numbers, the prompt, and how each outcome closes.
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
vi.mock('./admission/newWorkGate', async original => ({ ...await original<object>(), readAdmissionSettings: async () => ({ ok: true, identityGuard: false }) }));
vi.mock('./agent/context', async original => ({ ...await original<object>(), assertRuntimeRequestCapacity: () => undefined }));
vi.mock('./provider/providerRequest', async original => ({ ...await original<object>(),
  openRouterRequestBody: (_body: string, options: { context: Record<string, unknown>; phase: string }) => { h.request.push(options); return 'REQUEST'; } }));
vi.mock('./provider/openRouterAdapter', async original => ({ ...await original<object>(), openRouterAdapter: () => ({}) }));
vi.mock('./call', async original => ({ ...await original<object>(), modelCall: h.call }));
vi.mock('./agent/runner', async original => ({ ...await original<object>(), runRuntime: h.runtime }));
vi.mock('./quote', async original => ({ ...await original<object>(), chatQuote: h.chatQuote }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const material = [{ documentId: uuid(30), filename: 'a.md', text: '哎下班到家都七点了，咋整。\n一口锅搞定呗。' }];
const input = { actorId: 'actor', requestId: uuid(2), versionId: uuid(3), material };
const quote = { pricing: { version: 'nominal-v1' }, modelId: uuid(20), model: 'openai/gpt-6-luna', q: '100', multiplier: '6',
  upperUsd: '0.05', outputLimit: 8192, inputLimit: 112000, reasoning: { parameter: 'none' },
  providerLimits: { providerSlug: 'openai', contextTokens: 200000, promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0' },
  identity: { account: 'test' }, credential: async () => 'KEY', concurrency: 4 };
const GOOD = JSON.stringify({ tone: '口语', sentenceLength: '短', openings: '吐槽', stance: '温和', phrases: [], avoid: [], platforms: '',
  samples: ['哎下班到家都七点了，咋整。', '一口锅搞定呗。'] });

function harness(over: { generating?: boolean; replay?: boolean; openError?: string; erased?: boolean; gate?: { message?: unknown; calls?: unknown } } = {}) {
  const rpc: Array<[string, Record<string, unknown>]> = [];
  const respond = async (name: string, args: Record<string, unknown>) => {
    rpc.push([name, args]);
    if (name === 'turn_open' && over.openError) return { data: null, error: { code: 'P0001', message: over.openError, details: null } };
    if (name === 'turn_open') return { data: { turnId: 9, state: 'running', replay: over.replay ?? false, reservedCredits: 30, reservedUsd: 0.05,
      history: [], kindContext: { generating: over.generating ?? true } }, error: null };
    if (name === 'turn_close') return { data: { turnId: 9, closeKind: over.erased ? 'erased' : args.p_close_kind, chargedCredits: args.p_delivered ? 7 : 0,
      absorbedCredits: 0, settlement: 'done', replay: false }, error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  };
  const client = { rpc: respond, from: () => { throw new Error('no table reads'); } };
  const deps = { admin: {}, clients: { write: client, read: client }, slots: {},
    newWork: { message: async () => over.gate?.message ?? { ok: true }, calls: async () => over.gate?.calls ?? { ok: true } } } as unknown as ChatDeps;
  return { rpc, deps, names: () => rpc.map(([n]) => n), args: (name: string) => rpc.find(([n]) => n === name)![1] };
}
type Run = { exchange: (s: number, b: string) => Promise<string>; onText: (d: string) => void; instructions: string; input: string };
const runs = (text: string) => { h.call.mockResolvedValue('{}'); h.runtime.mockImplementation(async (o: Run) => { await o.exchange(1, '{}'); o.onText(text); return text; }); };

describe('kind=voice on the turn core (CORE-PATH-V2 V2-12 B7)', () => {
  beforeEach(() => { h.request.length = 0; h.call.mockReset(); h.runtime.mockReset(); h.chatQuote.mockReset(); h.chatQuote.mockResolvedValue(quote); });

  it('opens with no conversation, freezes one organizer call and saves the profile in the close', async () => {
    const t = harness(); runs(GOOD);
    expect(await runVoiceTurn(t.deps, input)).toEqual({ saved: true, turnId: 9 });
    const open = t.args('turn_open'), policy = open.p_policy as Record<string, unknown>;
    expect(open).toMatchObject({ p_kind: 'voice', p_session_id: null, p_request_id: input.requestId });
    expect(policy).toMatchObject({ gCredits: 30, minCredits: 15, historyItems: 0, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 },
      voice: { versionId: input.versionId } });
    expect(policy).not.toHaveProperty('fixedCredits');
    expect(h.chatQuote.mock.calls[0]![1]).toMatchObject({ modelId: uuid(20),
      use: { phase: 'attached_organizer', purpose: 'organize', outputCap: 8192 } });
    expect(t.names()).toEqual(['turn_open', 'turn_close']);
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'completed', p_delivered: true, p_messages: [], p_refund_all: false,
      p_kind_result: { versionId: input.versionId, profile: expect.objectContaining({ tone: '口语', samples: material[0]!.text.split('\n') }) } });
  });

  it('sends the instructions and the corpus, no tools, no history', async () => {
    const t = harness(); runs(GOOD);
    await runVoiceTurn(t.deps, input);
    const run = h.runtime.mock.calls[0]![0] as Run & { maxTurns: number; tools: unknown[]; readSessionHistory: boolean };
    expect(run.instructions).toContain('写作风格分析师');
    expect(run.input).toContain('### 文件 1：a.md');
    expect(run.input).toContain('一口锅搞定呗。');
    expect(run).toMatchObject({ maxTurns: 1, tools: [], readSessionHistory: false });
    expect(h.request[0]).toMatchObject({ phase: 'ordinary' });
  });

  it('an answer that is no usable profile closes failed with the whole freeze refunded, and saves nothing', async () => {
    const t = harness(); runs('好的');
    expect(await runVoiceTurn(t.deps, input)).toEqual({ saved: false, code: 'VOICE_FORMAT_INVALID', turnId: 9 });
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true, p_delivered: false,
      p_failure_code: 'voice_format_invalid', p_kind_result: null });
  });

  it('a refusal before the turn opens freezes and writes nothing', async () => {
    for (const [gate, code] of [[{ ok: false, reason: 'paused' }, 'VOICE_PAUSED'], [{ ok: false, reason: 'call_limited' }, 'VOICE_RATE_LIMITED']] as const) {
      const t = harness({ gate: { message: gate } }); runs(GOOD);
      expect(await runVoiceTurn(t.deps, input)).toEqual({ saved: false, code });
      expect(t.names()).toEqual([]);
    }
    const open = harness({ openError: 'TURN_INSUFFICIENT_CREDITS' }); runs(GOOD);
    expect(await runVoiceTurn(open.deps, input)).toEqual({ saved: false, code: 'VOICE_INSUFFICIENT_CREDITS' });
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it('a corpus the model cannot take is refused before anything is frozen', async () => {
    h.chatQuote.mockResolvedValue({ ...quote, inputLimit: 100 });
    const t = harness(); runs(GOOD);
    expect(await runVoiceTurn(t.deps, input)).toEqual({ saved: false, code: 'VOICE_UNAVAILABLE' });
    expect(t.names()).toEqual([]);
  });

  it('a model that is not admitted is told apart from a failing one', async () => {
    const { QuoteError } = await import('./quote');
    h.chatQuote.mockRejectedValue(new QuoteError('TURN_MODEL_NOT_ADMITTED'));
    expect(await runVoiceTurn(harness().deps, input)).toEqual({ saved: false, code: 'VOICE_MODEL_UNAVAILABLE' });
    h.chatQuote.mockRejectedValue(new Error('boom'));
    expect(await runVoiceTurn(harness().deps, input)).toEqual({ saved: false, code: 'VOICE_UNAVAILABLE' });
  });

  it('a version no longer generating closes the opened turn refunded and calls no model', async () => {
    const t = harness({ generating: false }); runs(GOOD);
    expect(await runVoiceTurn(t.deps, input)).toEqual({ saved: false, code: 'VOICE_VERSION_GONE', turnId: 9 });
    expect(t.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true });
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it('a repeated request runs nothing again', async () => {
    const t = harness({ replay: true }); runs(GOOD);
    expect(await runVoiceTurn(t.deps, input)).toMatchObject({ saved: false, turnId: 9 });
    expect(t.names()).toEqual(['turn_open']);
    expect(h.runtime).not.toHaveBeenCalled();
  });

  it('a version deleted during the call is a tombstone: the close is erased and the profile is not reported as saved', async () => {
    const t = harness({ erased: true }); runs(GOOD);
    expect(await runVoiceTurn(t.deps, input)).toEqual({ saved: false, code: 'VOICE_VERSION_GONE', turnId: 9 });
    const stopped = harness(); h.runtime.mockImplementation(async () => { throw new TurnStop('TURN_TOMBSTONED'); });
    expect(await runVoiceTurn(stopped.deps, input)).toEqual({ saved: false, code: 'VOICE_VERSION_GONE', turnId: 9 });
    expect(stopped.args('turn_close')).toMatchObject({ p_close_kind: 'erased', p_refund_all: false });
  });

  it('an unknown outcome keeps the freeze for recovery; a refused call pays nothing', async () => {
    const unknown = harness(); h.runtime.mockImplementation(async () => { throw new TurnStop('TURN_CALL_UNKNOWN'); });
    expect(await runVoiceTurn(unknown.deps, input)).toEqual({ saved: false, code: 'VOICE_RESULT_PENDING', turnId: 9 });
    expect(unknown.args('turn_close')).toMatchObject({ p_close_kind: 'interrupted', p_refund_all: false, p_delivered: false });
    const refused = harness(); h.runtime.mockImplementation(async () => { throw new TurnStop('TURN_PROVIDER_402'); });
    expect(await runVoiceTurn(refused.deps, input)).toEqual({ saved: false, code: 'VOICE_PROVIDER_REJECTED', turnId: 9 });
    expect(refused.args('turn_close')).toMatchObject({ p_close_kind: 'failed', p_refund_all: true });
  });
});
