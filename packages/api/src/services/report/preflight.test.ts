/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reportPreflight } from './preflight';

const id = '11111111-2222-4333-8444-555555555555';
const input = { sessionId: id, projectId: id, roundId: id };
const user = { auth: { getUser: async () => ({ data: { user: { id, email_confirmed_at: '2026-01-01T00:00:00Z' } } }) } };
const manifest = { resources: ['report.md'], sections: ['One'], maxCharacters: 12000 };
const workflow = { id: 'fixture', version: 1, kind: 'document',
  steps: [{ id: 'step', title: 'Step', dependsOn: [], resources: ['step.md'], minLength: 1, maxLength: 100,
    requiresEvidence: false, requiredCapabilities: [] }],
  report: { id: 'report', version: 1, title: 'Report', sections: [{ title: 'One', stepId: 'step' }] },
  reportGeneration: manifest };
const card = { cardId: id, required: 3, offeredQualified: 2, offeredRounds: 2,
  choice: null, confirmationId: null, chosenQualified: null, chosenRounds: null, chosenAt: null };
function fixture(qualified: number, rounds = 2, choice: null | 'continue' | 'generate' = null, required = 3) {
  const rpc = vi.fn(async (name: string) => ({ error: null,
    data: name === 'report_source' ? { workflow: { ...workflow,
      reportGeneration: { ...manifest, minQualifiedBenchmarks: required } } }
      : { qualified, rounds, card: { ...card, choice } } }));
  const from = vi.fn(() => { throw new Error('UNEXPECTED_DIRECT_TABLE_OR_BILLING_ACCESS'); });
  const admin = { rpc, from } as unknown as SupabaseClient;
  return { rpc, from, run: () => reportPreflight(user as unknown as SupabaseClient, admin, input) };
}
it('two qualified benchmarks are refused before a report or fee can be created', async () => {
  const f = fixture(2);
  expect(await f.run()).toMatchObject({ qualified: 2, required: 3, canGenerate: false });
  expect(f.rpc.mock.calls.map(call => call[0])).toEqual(['report_source', 'research_user_shortfall']);
  expect(f.rpc).toHaveBeenCalledWith('report_source', { p_actor_id: id, p_session_id: id, p_project_id: id, p_round_id: id });
  expect(f.rpc).toHaveBeenCalledWith('research_user_shortfall', { a: id, s: id });
  expect(f.from).not.toHaveBeenCalled();
});
it.each([[3, 2, null, true], [2, 2, 'generate', true], [2, 2, 'continue', false],
  [0, 2, 'generate', false], [2, 1, 'generate', false]] as const)(
  'preserves the qualified-count and accepted shortfall rules (%s/%s/%s)', async (qualified, rounds, choice, accepted) => {
    expect(await fixture(qualified, rounds, choice).run()).toMatchObject({ canGenerate: accepted });
  });
it('uses the published manifest minimum and does not treat an older, lower shortfall choice as consent', async () => {
  expect(await fixture(3, 2, 'generate', 4).run()).toMatchObject({ required: 4, canGenerate: false });
  expect(await fixture(3, 2, null, 1).run()).toMatchObject({ required: 3, canGenerate: true });
});
it('denies another actor or round before returning any benchmark counts', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'REPORT_SOURCE_CONFLICT' } }));
  await expect(reportPreflight(user as unknown as SupabaseClient, { rpc } as unknown as SupabaseClient, input))
    .rejects.toMatchObject({ message: 'REPORT_SOURCE_CONFLICT' });
  expect(rpc).toHaveBeenCalledOnce();
});
it('requires a verified signed-in user before reading the source', async () => {
  const rpc = vi.fn();
  const anonymous = { auth: { getUser: async () => ({ data: { user: null } }) } };
  await expect(reportPreflight(anonymous as unknown as SupabaseClient, { rpc } as unknown as SupabaseClient, input))
    .rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
  expect(rpc).not.toHaveBeenCalled();
});
it('fails closed on a missing eligibility read and never exposes database details', async () => {
  const rpc = vi.fn(async (name: string) => name === 'report_source' ? { data: { workflow }, error: null }
    : { data: null, error: { message: 'private database failure' } });
  await expect(reportPreflight(user as unknown as SupabaseClient, { rpc } as unknown as SupabaseClient, input))
    .rejects.toMatchObject({ message: 'REPORT_UNAVAILABLE' });
});
