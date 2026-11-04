/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const mock = vi.hoisted(() => ({ rows: vi.fn(), quote: vi.fn() }));
vi.mock('./admission/admissionConfiguration', async original => ({ ...await original<object>(), readAdmissionConfiguration: mock.rows }));
vi.mock('./quote', async original => ({ ...await original<object>(), chatQuote: mock.quote }));
import { runChatTurn, type ChatDeps } from './chat';
import { QuoteError } from './quote';
import { CORE_PATH_SETTING } from './settingKeys';

/*
 * The quote is read while the admission gate answers (chat.ts quoteTurn), but a request must still get the refusal it always got:
 * the gate's, then the work check's, then the quote's. And nothing the early quote throws may be left unhandled.
 */
const core = { enabled: true, stopLoss: { limitUsd: 5, p: 2, poolSize: 3, uFastUsd: 0.1, uBigUsd: 1 }, decisionUpperUsd: '0.001' };
const input = { actorId: 'a', sessionId: 's', requestId: 'r', text: 'hi' };
const rows = (extra: Array<{ key: string; value: unknown }> = []) => Promise.resolve({ data: [{ key: CORE_PATH_SETTING, value: core, raw: '' },
  { key: 'primary_model_id', value: '00000000-0000-4000-8000-000000000009', raw: '' }, ...extra
  .map(row => ({ ...row, raw: '' }))], error: null });
const deps = (message: ChatDeps['newWork']['message']) => ({ admin: {} as SupabaseClient, clients: {} as never, slots: {} as never,
  newWork: { message, calls: vi.fn() } }) as unknown as ChatDeps;
const codes = async (chat: ChatDeps) => { const out: string[] = []; await runChatTurn(chat, input, event => { if (event.type === 'error') out.push(event.code); }); return out; };

describe('chat: the early quote does not change which refusal a request gets', () => {
  const unhandled = vi.fn();
  beforeEach(() => { mock.rows.mockReset(); mock.quote.mockReset(); unhandled.mockReset(); process.on('unhandledRejection', unhandled); });

  it('the gate\'s refusal wins when the quote would also refuse, and the quote\'s failure is not left unhandled', async () => {
    mock.rows.mockReturnValue(rows());
    mock.quote.mockRejectedValue(new QuoteError('TURN_PAYG_DISABLED'));
    const paused = deps(async () => ({ ok: false, reason: 'paused', retryAfter: 60 }));
    expect(await codes(paused)).toEqual(['TURN_NEW_CALLS_PAUSED']);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('with the gate open the quote\'s own refusal code is sent', async () => {
    mock.rows.mockReturnValue(rows());
    mock.quote.mockRejectedValue(new QuoteError('TURN_PAYG_DISABLED'));
    expect(await codes(deps(async () => ({ ok: true })))).toEqual(['TURN_PAYG_DISABLED']);
    mock.quote.mockRejectedValue(new Error('private database text'));
    expect(await codes(deps(async () => ({ ok: true })))).toEqual(['TURN_QUOTE_UNAVAILABLE']);
    mock.quote.mockRejectedValue(new Error('TURN_PRICE_UNAVAILABLE'));
    expect(await codes(deps(async () => ({ ok: true })))).toEqual(['TURN_PRICE_UNAVAILABLE']);
    process.off('unhandledRejection', unhandled);
  });

  it('a budget setting that cannot be read still throws (after the gate), as it did before', async () => {
    mock.rows.mockReturnValue(rows([{ key: 'runtime_purpose_budgets', value: { nonsense: true } }]));
    mock.quote.mockResolvedValue({});
    await expect(codes(deps(async () => ({ ok: true })))).rejects.toThrow();
    // The gate still wins over a bad budget setting.
    expect(await codes(deps(async () => ({ ok: false, reason: 'call_limited', retryAfter: 5 })))).toEqual(['TURN_RATE_LIMITED']);
    process.off('unhandledRejection', unhandled);
  });

  it('the quote is asked for before the gate has answered', async () => {
    mock.rows.mockReturnValue(rows());
    mock.quote.mockRejectedValue(new QuoteError('TURN_PAYG_DISABLED'));
    let release!: () => void;
    const gate = deps(() => new Promise(resolve => { release = () => resolve({ ok: true }); }));
    const pending = codes(gate);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mock.quote).toHaveBeenCalledTimes(1);
    release();
    expect(await pending).toEqual(['TURN_PAYG_DISABLED']);
    process.off('unhandledRejection', unhandled);
  });
});
