/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it, vi } from 'vitest';
import { finishExhaustedReplay } from './executorOutcome';
const args = { p_execution_id: '10000000-0000-4000-8000-000000000001' };
const exhausted = { live: false, remainingCalls: 0, state: 'running' };
it.each(['RUNTIME_RESPONSE_PENDING', 'RUNTIME_RESPONSE_CONFLICT', 'RUNTIME_RESPONSE_INVALID', 'RUNTIME_TERMINAL_REPLY'])
('routes only definite undeliverable exhausted replay to existing compensation: %s', async code => {
  const rpc = vi.fn(async () => ({ state: 'cancelled' })) as never;
  expect(await finishExhaustedReplay(rpc, args, exhausted, code)).toEqual({ state: 'cancelled', unavailable: 'preflight' });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('runtime_execution', {
    ...args, p_action: 'fail_platform', p_result: { unavailable_reason: 'preflight' },
  });
});
it.each(['RUNTIME_DATABASE_UNAVAILABLE', 'BILL2_DATABASE_UNAVAILABLE', 'RUNTIME_AUTH_UNAVAILABLE',
  'RUNTIME_DENIED', 'RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY', 'RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY',
  'RUNTIME_CONTEXT_REVOKED', 'RUNTIME_ACCOUNT_CLOSED', 'RUNTIME_OUTPUT_TRUNCATED', 'UNCLASSIFIED'])
('does not refund a transient, user-side, revoked or uncertain failure: %s', async code => {
  const rpc = vi.fn();
  expect(await finishExhaustedReplay(rpc, args, exhausted, code)).toBeUndefined(); expect(rpc).not.toHaveBeenCalled();
});
it.each([{ ...exhausted, live: true }, { ...exhausted, remainingCalls: 1 }, { ...exhausted, remainingCalls: undefined },
  { ...exhausted, state: 'waiting_resume' }, { ...exhausted, state: 'cancelled' }, { ...exhausted, state: 'completed' }])
('does not create compensation authority for %j', async execution => {
  const rpc = vi.fn();
  expect(await finishExhaustedReplay(rpc, args, execution, 'RUNTIME_RESPONSE_PENDING')).toBeUndefined();
  expect(rpc).not.toHaveBeenCalled();
});
it.each(['cost_pending', 'running', 'outage'])('does not claim a refund or ordinary cancel before it commits: %s', async state => {
  const rpc = vi.fn(async () => { if (state === 'outage') throw new Error('RUNTIME_DATABASE_UNAVAILABLE'); return { state }; }) as never;
  expect(await finishExhaustedReplay(rpc, args, exhausted, 'RUNTIME_RESPONSE_PENDING'))
    .toEqual({ state: state === 'cost_pending' ? 'cost_pending' : 'pending' });
  expect(rpc).toHaveBeenCalledTimes(1);
});
