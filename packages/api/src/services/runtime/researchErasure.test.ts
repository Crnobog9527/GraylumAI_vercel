/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// #1029 P1: an erasure BILL2 confirms while a subcall is recorded closes the turn; nothing more reaches the client.
import { expect, it, vi } from 'vitest';
import { researchExecution } from './researchExecution';
import { frozenResearchTurn, RESEARCH_PHASE, RESEARCH_RESULT_RESERVE_BYTES, RESEARCH_TURN_VERSION } from './researchTurn';
import { runSubcall } from '../research/runtime/subcall';
import type { ResearchTurnEvent } from '../../shared/researchTurn';

vi.mock('../research/runtime/subcall', async original => ({
  ...await original<typeof import('../research/runtime/subcall')>(), runSubcall: vi.fn() }));
const id = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
const research = frozenResearchTurn.parse({ version: RESEARCH_TURN_VERSION, configRevision: 1, phase: RESEARCH_PHASE, subcalls: 2,
  reserve: RESEARCH_RESULT_RESERVE_BYTES, vendors: ['parallel'], verifiedPlatforms: [], benchmarkPlatforms: [],
  routes: [{ platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' }],
  discoverSubcalls: 2, recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' } });

it.each(['accountClosed', 'contentDeleted'] as const)('a subcall receipt reporting %s ends the turn without another event', async flag => {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'research_runtime_read') return { data: null, error: null };
    if (name === 'bill2_record') return { data: { [flag]: true }, error: null };
    throw new Error(name);
  });
  vi.mocked(runSubcall).mockImplementation(async context => {
    await context.billing.record(id(9), {} as never);
    return { sent: false, stop: flag === 'accountClosed' ? 'ACCOUNT_CLOSED' : 'CONTENT_DELETED', budget: false };
  });
  const events: ResearchTurnEvent[] = [];
  const onClosed = vi.fn();
  const built = researchExecution({ research, tools: ['web_search'], executionId: id(1), actorId: id(2), database: { rpc },
    execution: { sessionId: id(3), runId: id(4), epoch: 1, live: true, billing: { callPolicy: [] } } as never,
    emit: event => events.push(event), onClosed, onWaitingCredits: () => {}, canSend: () => true })!;
  await expect(built.tools[0]!.execute({ query: 'coffee', mode: 'fast' }, 'call-1')).rejects.toThrow('RUNTIME_ACCOUNT_CLOSED');
  expect(onClosed).toHaveBeenCalledOnce();
  // Only the event from before the confirmed erasure; the finishing event with the query is never sent.
  expect(events.map(event => event.type === 'research_call' && event.state)).toEqual(['running']);
});
