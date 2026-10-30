/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * CORE-PATH-V2 V2-7b: how a jury turn advances one group (turn/jury.ts). The review's own decisions (reviewCore), the call
 * group (runGroup) and the database are replaced; what is checked is which step is claimed, how the outcome of the group
 * moves the review and how the turn is closed (fixed-price delivery, refunds, waiting, unknown results).
 */
const m = vi.hoisted(() => ({ settings: vi.fn(), member: vi.fn(), read: vi.fn(), decide: vi.fn(), buildMembers: vi.fn(), runGroup: vi.fn(), close: vi.fn(), rpc: vi.fn(),
  callsAt: vi.fn() }));
vi.mock('../fusion/reviewRecord', async original => ({ ...(await original<typeof import('../fusion/reviewRecord')>()),
  reviewRecord: () => ({ read: m.read, replay: vi.fn() }) }));
vi.mock('../fusion/reviewCore', async original => ({ ...(await original<typeof import('../fusion/reviewCore')>()),
  reviewCore: () => ({ readSource: async () => ({ body: 'b', sections: ['One'], maxCharacters: 100, declared: [] }),
    callsAt: m.callsAt, buildMembers: m.buildMembers, decide: m.decide,
    phaseOf: (at: { round: number; phase: string }) => at.phase === 'summary' ? 'summary' : at.round > 1 ? 'debate' : 'review',
    opinionRules: async () => ({ sections: ['One'] }), revisionInput: () => ({}) }) }));
vi.mock('./fusionCalls', async original => ({ ...(await original<typeof import('./fusionCalls')>()),
  runGroup: m.runGroup, fusionDatabase: () => ({ close: m.close }) }));
vi.mock('./fusionQuote', () => ({ fusionQuote: async (_a: unknown, i: { modelId: string }) => ({ modelId: i.modelId, q: '100',
  multiplier: '6', outputLimit: 100, reasoning: {}, policy: {} }), fusionCall: (quote: object) => ({ ...quote, upperUsd: '0.01' }) }));
vi.mock('../fusion/request', async original => ({ ...(await original<typeof import('../fusion/request')>()), fusionRequestBody: () => '{}' }));
vi.mock('../fusion/settings', async original => ({ ...(await original<typeof import('../fusion/settings')>()),
  readFusionSettings: async () => m.settings() }));
vi.mock('../membershipEntitlements', () => ({ readMembershipEntitlements: async () => ({}),
  assertFusionEntitlement: () => { if (m.member() === false) throw new Error('FUSION_MEMBERSHIP_REQUIRED'); } }));
vi.mock('../models/openRouterKey', async original => ({ ...(await original<typeof import('../models/openRouterKey')>()),
  readOpenRouterKeyOrUnset: async () => 'SYNTHETIC' }));
import { estimateQuotes, juryTurn } from './jury';

const REVIEWERS = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
const SUMMARY = '00000000-0000-4000-8000-0000000000d0';
const cfg = { path: 'turn', estimateUsd: '1', maxRounds: 2, reviewers: REVIEWERS, summary: SUMMARY, opinionTokens: 100, summaryTokens: 100,
  skill: { skillId: SUMMARY, revisionId: SUMMARY, packageHash: 'h' },
  callCaps: { review: Object.fromEntries(REVIEWERS.map(id => [id, { credits: 60, usd: '0.1' }])), debate: {},
    summary: { [SUMMARY]: { credits: 60, usd: '0.1' } } } };
const view = (over: Record<string, unknown> = {}) => ({ reviewId: '00000000-0000-4000-8000-000000000001', state: 'running', round: 1,
  phase: 'review', attempt: 1, turnId: 7, config: cfg, steps: [], calls: [], ...over });
const admin = { rpc: m.rpc } as never;
const jury = () => juryTurn({ admin, clients: { write: admin, read: admin } as never, slots: { take: async () => 1, drop: async () => undefined },
  calls: async () => ({ ok: true }) }, 'actor');
const member = { modelId: REVIEWERS[0], phase: 'fusion_review', request: { instructions: 'i', input: 'x' } };

beforeEach(() => {
  vi.resetAllMocks();
  m.rpc.mockResolvedValue({ data: {}, error: null });
  m.callsAt.mockReturnValue([]);
  m.buildMembers.mockResolvedValue(REVIEWERS.map(modelId => ({ ...member, modelId })));
  m.runGroup.mockResolvedValue(REVIEWERS.map(() => ({ ok: true, text: '{}', verdict: 'usable' })));
  m.close.mockResolvedValue({ turnId: 7, closeKind: 'completed', chargedCredits: 1500, settlement: 'done', replay: false });
  m.settings.mockReturnValue({ review: { enabled: true, reviewerModelIds: REVIEWERS, summaryModelId: SUMMARY } });
  m.member.mockReturnValue(true);
});

describe('jury estimate quotes', () => {
  it('a model that is both a reviewer and the summary is estimated with the larger output limit (#1522 review)', () => {
    const quote = (modelId: string, outputLimit: number) => ({ modelId, outputLimit, multiplier: '6', policy: { providerLimits: {} } }) as never;
    expect(estimateQuotes([quote('a', 4096), quote('b', 4096), quote('a', 16384)]).map(q => [q.modelId, q.outputLimit]))
      .toEqual([['a', 16384], ['b', 4096]]);
  });
});

describe('jury turn advance', () => {
  it('claims the step with its first sequence, runs the seats in parallel and moves on', async () => {
    m.read.mockResolvedValue(view({ calls: [{ seq: 3 }] }));
    m.decide.mockResolvedValue({ state: 'running', round: 1, phase: 'summary', attempt: 1 });
    expect(await jury().advance('r')).toMatchObject({ next: true, reason: 'advanced', dispatched: 3 });
    expect(m.rpc).toHaveBeenCalledWith('fusion_review_turn_step', expect.objectContaining({
      p_from: { round: 1, phase: 'review', attempt: 1 }, p_to: { state: 'claim', fromSeq: 4 } }));
    expect(m.runGroup.mock.calls[0]![1]).toHaveLength(3);
    expect(m.rpc).toHaveBeenLastCalledWith('fusion_review_turn_step', expect.objectContaining({
      p_to: { state: 'running', round: 1, phase: 'summary', attempt: 1 } }));
    expect(m.close).not.toHaveBeenCalled();
  });
  it('closes delivered at the fixed price on a revised summary; no change and failures refund', async () => {
    m.read.mockResolvedValue(view({ phase: 'summary' }));
    m.buildMembers.mockResolvedValue([{ ...member, modelId: SUMMARY, phase: 'fusion_summary' }]);
    m.decide.mockResolvedValueOnce({ state: 'completed', outcome: { kind: 'revised' } });
    await jury().advance('r');
    expect(m.close).toHaveBeenLastCalledWith({ turnId: 7, kind: 'completed', delivered: true, refundAll: false, failureCode: null,
      product: { state: 'completed', outcome: { kind: 'revised' } } });
    m.decide.mockResolvedValueOnce({ state: 'completed', outcome: { kind: 'no_change' } });
    await jury().advance('r');
    expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'completed', delivered: false, refundAll: false }));
    m.decide.mockResolvedValueOnce({ state: 'revision_failed', outcome: { kind: 'revision_failed' } });
    await jury().advance('r');
    expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failed', delivered: false, refundAll: true,
      failureCode: 'review_revision_failed' }));
  });
  it('a billed response without an answer is a settled seat, not an unknown one: the review goes on (#1522 review)', async () => {
    m.read.mockResolvedValue(view());
    m.runGroup.mockResolvedValueOnce(REVIEWERS.map(() => ({ ok: true, text: '', verdict: 'no_delivery', empty: true })));
    m.decide.mockResolvedValueOnce({ state: 'incomplete', outcome: { kind: 'no_opinions' } });
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'ended' });
    expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failed', refundAll: true }));
  });
  it('a paused platform or an exhausted call limit claims nothing; a claimed step never sent is sent later (#1522 review)', async () => {
    m.read.mockResolvedValue(view());
    const gated = juryTurn({ admin, clients: { write: admin, read: admin } as never, slots: { take: async () => 1, drop: async () => undefined },
      calls: async () => ({ ok: false, reason: 'paused' }) as never }, 'actor');
    expect(await gated.advance('r')).toMatchObject({ next: false, reason: 'gated' });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.runGroup).not.toHaveBeenCalled();
    // Claimed earlier, nothing begun: the group is sent now (no second claim), not decided as finished.
    m.read.mockResolvedValue(view({ steps: [{ round: 1, phase: 'review', attempt: 1, groupId: 'g', stepKey: 'review:1:review:1', claimedAt: 'x' }],
      calls: [] }));
    m.decide.mockResolvedValueOnce({ state: 'running', round: 1, phase: 'summary', attempt: 1 });
    expect(await jury().advance('r')).toMatchObject({ next: true, reason: 'advanced', dispatched: 3 });
    expect(m.runGroup).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls.filter(c => (c[1] as { p_to: { state: string } }).p_to.state === 'claim')).toHaveLength(0);
  });
  it('waits for credits, leaves an unknown result to recovery, and never sends a group twice', async () => {
    m.read.mockResolvedValue(view());
    m.runGroup.mockResolvedValueOnce([{ ok: false, code: 'TURN_PAUSED_FOR_CREDITS' }, { ok: false, code: 'TURN_PAUSED_FOR_CREDITS' }]);
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'waiting_credits' });
    m.runGroup.mockResolvedValueOnce([{ ok: true, text: '{}', verdict: 'usable' }, { ok: false, code: 'TURN_CALL_UNKNOWN' }]);
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'in_flight' });
    expect(m.close).not.toHaveBeenCalled();
    // A claimed step with a call still in flight (an invocation cut off): nothing is sent again.
    m.read.mockResolvedValue(view({ steps: [{ round: 1, phase: 'review', attempt: 1, groupId: 'g', stepKey: 'review:1:review:1', claimedAt: 'x' }],
      calls: [{ groupId: 'g', state: 'identified', seq: 1 }] }));
    m.runGroup.mockClear();
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'in_flight' });
    expect(m.runGroup).not.toHaveBeenCalled();
  });
  it('a step whose call was sent but whose receipt failed to save is never retried (#1522 review)', async () => {
    m.read.mockResolvedValueOnce(view()).mockResolvedValue(view({
      steps: [{ round: 1, phase: 'review', attempt: 1, groupId: 'g', stepKey: 'review:1:review:1', claimedAt: 'x' }],
      calls: [{ groupId: 'g', state: 'identified', seq: 1 }] }));
    m.runGroup.mockResolvedValueOnce(REVIEWERS.map(() => ({ ok: false, code: 'TURN_DATABASE_UNAVAILABLE' })));
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'in_flight' });
    expect(m.rpc.mock.calls.filter(c => (c[1] as { p_to: { state: string } }).p_to.state === 'running')).toHaveLength(0);
  });
  it('a model record re-pointed since the start gets no further paid call of the review (#1522 review)', async () => {
    m.read.mockResolvedValue(view({ config: { ...cfg, models: Object.fromEntries(REVIEWERS.map(id => [id, 'old/route'])) } }));
    expect(await jury().advance(view().reviewId)).toMatchObject({ next: false, reason: 'ended' });
    expect(m.runGroup).not.toHaveBeenCalled();
    expect(m.close).toHaveBeenCalledWith(expect.objectContaining({ refundAll: true, product: expect.objectContaining({ state: 'incomplete' }) }));
  });

  it('a review ended while its group ran is settled by that end, not by the answers just saved (#1522 review)', async () => {
    m.read.mockResolvedValueOnce(view()).mockResolvedValue(view({ state: 'incomplete', outcome: { kind: 'source_archived' }, fee: { state: 'held' } }));
    expect(await jury().advance(view().reviewId)).toMatchObject({ next: false, reason: 'ended' });
    expect(m.decide).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledWith('turn_fusion_ended_review', expect.objectContaining({ p_state: 'incomplete' }));
  });

  it('an answer saved and judged whose cost alone is pending does not hold the step (#1522 review)', async () => {
    const group = 'g1', claimedStep = { stepKey: 'review:1:review:1', groupId: group, fromSeq: 1 };
    const pendingCost = REVIEWERS.map((modelId, index) => ({ callId: String(index), groupId: group, modelId, phase: 'fusion_review',
      state: 'identified', verdict: 'usable', seq: index + 1 }));
    m.read.mockResolvedValue(view({ steps: [claimedStep], calls: pendingCost }));
    m.decide.mockResolvedValue({ state: 'running', round: 1, phase: 'summary', attempt: 1 });
    expect(await jury().advance(view().reviewId)).toMatchObject({ next: true, reason: 'advanced' });
    // Without a judged answer the same call still waits for recovery.
    m.read.mockResolvedValue(view({ steps: [claimedStep], calls: pendingCost.map(c => ({ ...c, verdict: null })) }));
    expect(await jury().advance(view().reviewId)).toMatchObject({ next: false, reason: 'in_flight' });
  });

  it('retries a step nothing of which was sent, then gives up after three attempts; a tombstone closes erased', async () => {
    m.read.mockResolvedValue(view());
    m.runGroup.mockResolvedValue(REVIEWERS.map(() => ({ ok: false, code: 'TURN_PROVIDER_BUSY' })));
    expect(await jury().advance('r')).toMatchObject({ next: true, reason: 'retry' });
    expect(m.rpc).toHaveBeenLastCalledWith('fusion_review_turn_step', expect.objectContaining({
      p_to: { state: 'running', round: 1, phase: 'review', attempt: 2 } }));
    m.read.mockResolvedValue(view({ attempt: 3 }));
    m.decide.mockResolvedValueOnce({ state: 'incomplete', outcome: { kind: 'no_opinions' } });
    await jury().advance('r');
    expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failed', refundAll: true }));
    m.runGroup.mockResolvedValueOnce([{ ok: false, code: 'TURN_TOMBSTONED' }]);
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'ended' });
    expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'erased', product: { state: 'interrupted', outcome: { kind: 'erased' } } }));
  });
  it('a seat above its frozen cap ends round 1 as incomplete and skips a debate round', async () => {
    vi.mocked(m.buildMembers).mockResolvedValue([{ ...member }]);
    const over = { ...cfg, callCaps: { ...cfg.callCaps, review: { [REVIEWERS[0]!]: { credits: 1, usd: '0.001' } } } };
    m.read.mockResolvedValue(view({ config: over }));
    expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'ended' });
    expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failed', refundAll: true,
      product: { state: 'incomplete', outcome: { kind: 'price_changed', phase: 'review' } } }));
    m.read.mockResolvedValue(view({ config: over, round: 2 }));
    expect(await jury().advance('r')).toMatchObject({ next: true, reason: 'advanced' });
    expect(m.rpc).toHaveBeenLastCalledWith('fusion_review_turn_step', expect.objectContaining({
      p_to: { state: 'running', round: 2, phase: 'summary', attempt: 1 } }));
  });
  it('a switch turned off, a lost membership or a model removed from the panel sends nothing more and refunds (#1522 review)', async () => {
    m.read.mockResolvedValue(view());
    for (const [setup, reason] of [
      [() => m.settings.mockReturnValue({ review: { enabled: false, reviewerModelIds: REVIEWERS, summaryModelId: SUMMARY } }), 'FUSION_REVIEW_DISABLED'],
      [() => m.member.mockReturnValue(false), 'FUSION_MEMBERSHIP_REQUIRED'],
      [() => m.settings.mockReturnValue({ review: { enabled: true, reviewerModelIds: REVIEWERS.slice(1), summaryModelId: SUMMARY } }), 'FUSION_MODEL_DENIED'],
    ] as const) {
      m.settings.mockReturnValue({ review: { enabled: true, reviewerModelIds: REVIEWERS, summaryModelId: SUMMARY } });
      m.member.mockReturnValue(true);
      setup();
      m.runGroup.mockClear();
      expect(await jury().advance('r')).toMatchObject({ next: false, reason: 'ended' });
      expect(m.runGroup).not.toHaveBeenCalled();
      expect(m.close).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failed', refundAll: true,
        product: { state: 'incomplete', outcome: { kind: 'claim_refused', reason, phase: 'review' } } }));
    }
  });
  it('an ended review or one on the BILL2 path is not advanced; one ended elsewhere closes its open turn (#1522 review)', async () => {
    m.read.mockResolvedValueOnce(view({ state: 'completed', fee: { state: 'charged' } }));
    expect(await jury().advance('r')).toEqual({ next: false, reason: 'ended' });
    expect(m.rpc).not.toHaveBeenCalled();
    m.read.mockResolvedValueOnce(view({ state: 'incomplete', outcome: { kind: 'source_archived' }, fee: { state: 'held' } }));
    expect(await jury().advance('r')).toEqual({ next: false, reason: 'ended' });
    expect(m.rpc).toHaveBeenCalledWith('turn_fusion_ended_review', { p_actor_id: 'actor', p_turn_id: 7, p_state: 'incomplete',
      p_outcome: { kind: 'source_archived' } });
    m.read.mockResolvedValueOnce(view({ turnId: null }));
    expect(await jury().advance('r')).toEqual({ next: false, reason: 'not_turn_path' });
  });
});
