/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { erasureFinancialBudget } from '../accountErasure/financialRecovery';
import { OWNER_LOST_BATCH_SIZE, OWNER_LOST_PAGE_SIZE, OWNER_LOST_WINDOW_MS, recoverOwnerLostReplies } from './ownerLostRecovery';

const actor = '10000000-0000-4000-8000-000000000001';
const ids = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const since = (n: number) => new Date(Date.parse('2026-10-24T00:00:00Z') + n * 1000).toISOString();
const round = (n: number, executionState: string, savedReplyChars: number) => ({
  executionId: ids(n), runId: ids(n), actorId: actor, chargedCredits: 14, since: since(n),
  evidence: { model: 'primary', streamed: true, executionState, unavailableReason: null, calls: 1, outputTokens: 200,
    savedReplyChars, lastActivityAt: '2026-10-24T15:41:57Z', lastFinishReason: 'stop' },
});
function fixture(rounds: unknown[], read: (args: Record<string, unknown>) => { data: unknown; error: unknown } =
  () => ({ data: { state: 'waiting_resume' }, error: null })) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'runtime_stale_charged_rounds'
    ? { data: { total: rounds.length, rounds }, error: null } : read(args));
  let order = 0;
  return { rpc, input: { database: { rpc }, budget: erasureFinancialBudget(45_000), now: Date.parse('2026-10-24T15:50:00Z'),
    random: () => order++ } };
}

it('hands back only running or interrupted rounds with a saved reply, through the SQL read that owns the lease', async () => {
  // staging 2026-10-24: the organizer claim timed out after the mentor reply was saved, and the round stayed running.
  const f = fixture([round(1, 'running', 620), round(2, 'interrupted', 80), round(3, 'running', 0), round(4, 'cost_pending', 50)]);
  expect(await recoverOwnerLostReplies(f.input)).toEqual({ selected: 2, processed: 2, settled: 0, pending: 2, failed: 0 });
  expect(f.rpc).toHaveBeenCalledWith('runtime_stale_charged_rounds', { p_cutoff: '2026-10-24T15:50:00.000Z', p_limit: 100,
    p_created_since: new Date(Date.parse('2026-10-24T15:50:00Z') - OWNER_LOST_WINDOW_MS).toISOString() });
  expect(f.rpc.mock.calls.filter(([name]) => name === 'runtime_execution').map(([, args]) => args)).toEqual([
    { p_actor_id: actor, p_execution_id: ids(1), p_action: 'read' },
    { p_actor_id: actor, p_execution_id: ids(2), p_action: 'read' },
  ]);
  // Lookup-only: never a cancel, a refund or any owner write.
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain('runtime_cancel');
});

it('a refused read stays pending for the 24-hour refund instead of failing every scheduled run', async () => {
  const f = fixture([round(1, 'running', 620), round(2, 'running', 620)],
    args => args.p_execution_id === ids(1) ? { data: null, error: { message: 'RUNTIME_TEST_WINDOW_DENIED' } }
      : { data: { state: 'waiting_resume' }, error: null });
  expect(await recoverOwnerLostReplies(f.input)).toEqual({ selected: 2, processed: 1, settled: 0, pending: 2, failed: 0 });
});

it('an unreadable report is a failure, and no time left means no request at all', async () => {
  const broken = fixture([]);
  broken.rpc.mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });
  expect((await recoverOwnerLostReplies(broken.input)).failed).toBe(1);
  const late = fixture([round(1, 'running', 620)]);
  late.input.budget = erasureFinancialBudget(1_000);
  expect(await recoverOwnerLostReplies(late.input)).toEqual({ selected: 0, processed: 0, settled: 0, pending: 0, failed: 0 });
  expect(late.rpc).not.toHaveBeenCalled();
});

it('pages past rounds without a saved reply, advancing by creation time', async () => {
  const first = Array.from({ length: OWNER_LOST_PAGE_SIZE }, (_, i) => round(i + 1, 'running', 0));
  const second = [round(OWNER_LOST_PAGE_SIZE, 'running', 0), round(OWNER_LOST_PAGE_SIZE + 1, 'interrupted', 300)];
  const f = fixture([]);
  f.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'runtime_stale_charged_rounds'
    ? { data: { total: 101, rounds: args.p_created_since === since(OWNER_LOST_PAGE_SIZE) ? second : first }, error: null }
    : { data: { state: 'waiting_resume' }, error: null });
  expect(await recoverOwnerLostReplies(f.input)).toMatchObject({ selected: 1, processed: 1 });
  expect(f.rpc.mock.calls.filter(([name]) => name === 'runtime_stale_charged_rounds').map(([, args]) => args.p_created_since))
    .toEqual([new Date(f.input.now - OWNER_LOST_WINDOW_MS).toISOString(), since(OWNER_LOST_PAGE_SIZE)]);
  expect(f.rpc).toHaveBeenCalledWith('runtime_execution', { p_actor_id: actor, p_execution_id: ids(OWNER_LOST_PAGE_SIZE + 1),
    p_action: 'read' });
});

it('picks a random batch, so rounds whose read keeps failing cannot hold every slot', async () => {
  const rounds = Array.from({ length: OWNER_LOST_BATCH_SIZE + 5 }, (_, i) => round(i + 1, 'running', 100));
  const f = fixture(rounds);
  // The oldest rounds get the largest keys this time, so the newest five are read first.
  f.input.random = (() => { let n = rounds.length; return () => n--; })();
  await recoverOwnerLostReplies(f.input);
  const read = f.rpc.mock.calls.filter(([name]) => name === 'runtime_execution').map(([, args]) => args.p_execution_id);
  expect(read).toHaveLength(OWNER_LOST_BATCH_SIZE);
  expect(read.slice(0, 5)).toEqual([25, 24, 23, 22, 21].map(ids));
});
