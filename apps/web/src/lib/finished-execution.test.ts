/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { finishedExecution } from './finished-execution';

const call = (data: unknown, isSuccess = true) => ({ isSuccess, data, variables: { executionId: 'e1' } });

it.each(['completed', 'cancelled', 'cost_pending'])('names the execution whose execute call returned %s', state => {
  expect(finishedExecution(call({ state }))).toBe('e1');
});

it('does not treat a pending, running, failed or unread call as finished', () => {
  expect(finishedExecution(call({ state: 'pending' }))).toBeNull();
  expect(finishedExecution(call(undefined, false))).toBeNull();
  expect(finishedExecution(call({ state: 'completed' }, false))).toBeNull();
  expect(finishedExecution(call({}))).toBeNull();
  expect(finishedExecution({ isSuccess: false })).toBeNull();
});
