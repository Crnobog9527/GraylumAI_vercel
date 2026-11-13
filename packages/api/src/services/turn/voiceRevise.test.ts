/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ runtime: vi.fn(), call: vi.fn(), request: vi.fn(() => 'REQUEST') }));
vi.mock('./agent/runner', async original => ({ ...await original<object>(), runRuntime: h.runtime }));
vi.mock('./call', async original => ({ ...await original<object>(), modelCall: h.call }));
vi.mock('./provider/providerRequest', async original => ({ ...await original<object>(), openRouterRequestBody: h.request }));
import { TurnStop } from './call';
import { reviseVoiceDraft, voiceRewriteCalls } from './voiceRevise';
import { turnPolicy } from './policy';
import { resumeLimits } from './resume';

const shown = ['哎下班到家都七点了，咋整呢，一口锅搞定呗。'];
const draft = '周末去爬山。哎下班到家都七点了，咋整呢，真累！';
const gate = vi.fn(async () => {});
const args = { draft, shown, quote: { model: 'm', reasoning: { parameter: 'none' }, outputLimit: 8192 } as never, callDeps: {} as never,
  callPolicy: {}, callGate: gate };
type Run = { exchange: (s: number, b: string) => Promise<string>; instructions: string; input: string; tools: unknown[]; maxOutputTokens: number };

describe('rewriting the copied sentences (VOICE-2 PR-3)', () => {
  beforeEach(() => { h.runtime.mockReset(); h.call.mockReset(); gate.mockClear(); h.request.mockClear(); });

  it('no overlap: no call at all', async () => {
    expect(await reviseVoiceDraft({ ...args, draft: '周末去爬山。' })).toEqual({ text: '周末去爬山。', revised: 0 });
    expect(h.runtime).not.toHaveBeenCalled();
  });
  it('one call of this turn, through the call gate, for the copied sentences only; the draft gets the rewrite', async () => {
    h.call.mockResolvedValue('{}');
    h.runtime.mockImplementation(async (o: Run) => { await o.exchange(1, '{}'); expect(o.tools).toEqual([]); expect(o.maxOutputTokens).toBe(4096);
      expect(o.input).toContain('1. 哎下班到家都七点了，咋整呢，真累！'); expect(o.input).not.toContain('周末去爬山');
      return JSON.stringify({ 1: '回到家都七点多了，累得不想动！' }); });
    expect(await reviseVoiceDraft(args)).toEqual({ text: '周末去爬山。回到家都七点多了，累得不想动！', revised: 1 });
    expect(gate).toHaveBeenCalledWith(1);
    expect(h.call).toHaveBeenCalledTimes(1);
  });
  it('a deleted voice or a pause for credits ends the turn as any call would; any other failure keeps the draft', async () => {
    for (const code of ['TURN_TOMBSTONED', 'TURN_PAUSED_FOR_CREDITS'] as const) {
      h.runtime.mockRejectedValueOnce(new TurnStop(code));
      await expect(reviseVoiceDraft(args)).rejects.toMatchObject({ code });
    }
    h.runtime.mockRejectedValueOnce(new TurnStop('TURN_PROVIDER_BUSY'));
    expect(await reviseVoiceDraft(args)).toEqual({ text: draft, revised: 0 });
    h.runtime.mockRejectedValueOnce(new Error('down'));
    expect(await reviseVoiceDraft(args)).toEqual({ text: draft, revised: 0 });
  });
});

// #2001 review: the rewrite call must reach the freeze as another model call, or every turn of such a reply is refused at the open.
describe('the rewrite call in the freeze (turnPolicy, as chat.ts builds it)', () => {
  const base = { q: '100', multiplier: '6', modelUpperUsd: '0.05', historyItems: 100, inputBytes: 90000, startThresholdCredits: 12,
    stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 }, topUp: true, decisionUpperUsd: '0.001' };
  const quote = { upperUsd: '0.05', multiplier: '6' };
  const toolLimits = { paidTools: 0, freeTools: 2 };
  const chatLimits = (on: boolean) => { const other = voiceRewriteCalls(on, quote);
    return { other, limits: { model: 1 + toolLimits.paidTools + toolLimits.freeTools + other.length, ...toolLimits, decisions: 1 } }; };
  it('declared as another call of the same model: the policy is valid and its bound counts in G', () => {
    const { other, limits } = chatLimits(true);
    expect(other).toEqual([{ upperUsd: '0.05', multiplier: '6' }]);
    const on = turnPolicy({ ...base, limits, otherModelCalls: other });
    const off = turnPolicy({ ...base, ...chatLimits(false) });
    expect(on.limits.model).toBe(4);
    expect(on.gCredits).toBe(off.gCredits + off.uModelCredits);
    expect(on.holdCredits).toBe(off.holdCredits);
    // Without the declaration (what 681771ba did) the open is refused.
    expect(() => turnPolicy({ ...base, limits })).toThrow('TURN_POLICY_INVALID');
  });
  it('a resumed turn keeps the call declared, with or without a replayed first answer', () => {
    const { other, limits } = chatLimits(true);
    for (const replayed of [0, 1]) {
      const resumed = resumeLimits(limits, { model: 3, paidTools: 0, freeTools: 1, decisions: 1 } as never, other.length, replayed);
      expect(() => turnPolicy({ ...base, limits: resumed, otherModelCalls: other })).not.toThrow();
    }
  });
});
