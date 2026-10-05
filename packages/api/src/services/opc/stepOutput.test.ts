/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { opcService, opcSaveResult as exportedSchema } from './service';
import { opcSaveResult } from './stepOutput';
const id = '10000000-0000-4000-8000-000000000001';
const input = { draftId: id, executionId: id, requestId: id, stepId: 'step-1' };
function fixture(result: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const user = { auth: { getUser: async () => ({ data: { user: { id, email_confirmed_at: '2026-01-01' } }, error: null }) } };
  const admin = { rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { abortSignal: async () => ({ data: name === 'runtime_execution' ? { result } : { saved: true }, error: null }) };
  } };
  return { calls, service: opcService(user as unknown as SupabaseClient, admin as unknown as SupabaseClient) };
}
it.each([
  { completeness: 'length_limit' }, { organized: false }, { envelopeCompact: true },
  { completeness: 'stopped' }, { completeness: 'unknown' },
])('refuses non-complete step results before any mutation: %j', async result => {
  const f = fixture(result);
  await expect(f.service.saveResult(input)).rejects.toThrow('OPC_RESULT_DENIED');
  expect(f.calls).toEqual([{ name: 'runtime_execution', args: {
    p_execution_id: id, p_action: 'read', p_actor_id: id,
  } }]);
});
it.each([{}, { completeness: 'complete' }, { completeness: 'complete', organized: true }])(
  'allows complete and legacy results through the existing save RPC: %j', async result => {
    const f = fixture(result);
    expect(await f.service.saveResult(input)).toEqual({ saved: true });
    expect(f.calls.map(call => call.name)).toEqual(['runtime_execution', 'opc_save_result']);
    expect(f.calls[1]?.args).toEqual({ p_draft_id: id, p_execution_id: id, p_step_id: 'step-1', p_request_id: id, p_actor_id: id });
  });
it('preserves the public schema export and validates before database access', async () => {
  expect(exportedSchema).toBe(opcSaveResult);
  const f = fixture({});
  await expect(f.service.saveResult({ ...input, executionId: 'invalid' })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
