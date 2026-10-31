import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDeps } from './chat';

/*
 * CORE-PATH-V2 V2-7b: the estimate and the compare start requests (turn/fusionHttp.ts). The entry checks are POST /api/turn's;
 * what is checked here is which request shapes are refused before any work, how an estimate answers, and that a compare
 * start hands the quote the user saw to the turn.
 */
const m = vi.hoisted(() => ({ compare: vi.fn(), estimate: vi.fn(), allowed: vi.fn(), parts: vi.fn(), admit: vi.fn(), price: vi.fn(),
  quote: vi.fn(), key: vi.fn(), configuration: vi.fn() }));
vi.mock('./compare', () => ({ COMPARE_HISTORY_ITEMS: 100, runCompareTurn: m.compare }));
vi.mock('./jury', async original => ({ ...await original<object>(), juryTurn: () => ({ estimate: m.estimate }) }));
vi.mock('../fusion/compareAdmission', () => ({ assertCompareAllowed: m.allowed }));
vi.mock('../fusion/compareLoad', async original => ({ ...await original<object>(), loadCompareTurnParts: m.parts }));
vi.mock('./fusionCalls', async original => ({ ...await original<object>(), fusionAdmission: () => ({ compare: m.admit }),
  fusionCoreSetting: { safeParse: (value: unknown) => ({ success: true, data: value }) } }));
vi.mock('./compareQuote', () => ({ priceCompareColumns: m.price }));
vi.mock('./fusionQuote', () => ({ fusionQuote: m.quote }));
vi.mock('../models/openRouterKey', () => ({ readOpenRouterKeyOrUnset: m.key }));
vi.mock('../runtime/admissionConfiguration', () => ({ readAdmissionConfiguration: m.configuration }));
import { handleCompareStart, handleTurnEstimate, type FusionHttpDeps } from './fusionHttp';
import { CORE_PATH_SETTING } from './chat';

const SESSION = '00000000-0000-4000-8000-000000000001', REQUEST = '00000000-0000-4000-8000-000000000002';
const MODEL_A = '00000000-0000-4000-8000-00000000000a', MODEL_B = '00000000-0000-4000-8000-00000000000b';
const post = (body: unknown) => new Request('https://app.test/api/turn/estimate', { method: 'POST', body: JSON.stringify(body) });
const deps = (over: Partial<FusionHttpDeps> = {}): FusionHttpDeps => ({ authenticate: async () => 'actor-1', rateLimited: async () => false,
  databaseHost: { declared: 'db.test', actual: 'db.test' }, chat: { newWork: {} } as ChatDeps, userClient: () => ({}) as never, ...over });
const compareBody = { kind: 'compare', sessionId: SESSION, question: ' Which? ', modelIds: [MODEL_A, MODEL_B] };
const shown = { credits: 4, columns: [{ modelId: MODEL_A, credits: 2, usd: '0.02' }, { modelId: MODEL_B, credits: 2, usd: '0.02' }] };
const settingRows = { data: [{ key: CORE_PATH_SETTING, value: { enabled: true, stopLoss: {} } }], error: null };

beforeEach(() => {
  vi.resetAllMocks();
  m.configuration.mockResolvedValue(settingRows);
  m.allowed.mockResolvedValue({ answerOutputTokens: 100, maxBudgetUsd: '5' });
  m.key.mockResolvedValue('KEY');
  m.parts.mockResolvedValue({ skill: null, workspace: [], references: [], question: 'Which?' });
  m.admit.mockResolvedValue({ history: [{ seq: 1, role: 'user', content: 'hi' }], positioned: true });
  m.quote.mockResolvedValue({ modelId: MODEL_A });
  m.price.mockReturnValue({ credits: 4, tooLarge: [], overBudget: false,
    columns: [{ modelId: MODEL_A, upperCredits: 2, upperUsd: '0.02' }, { modelId: MODEL_B, upperCredits: 2, upperUsd: '0.02' }] });
});

describe('POST /api/turn/estimate', () => {
  const status = async (body: unknown, d = deps()) => { const res = await handleTurnEstimate(post(body), d); return [res.status, await res.json()]; };

  it('refuses before any work: shape, database host, account, rate limit', async () => {
    const invalid = [400, { error: 'TURN_REQUEST_INVALID' }];
    expect(await status({ ...compareBody, question: '  ' })).toEqual(invalid);
    expect(await status({ ...compareBody, modelIds: [] })).toEqual(invalid);
    expect(await status({ ...compareBody, extra: 1 })).toEqual(invalid);
    expect(await status({ kind: 'jury', draftId: SESSION })).toEqual(invalid);
    expect(await status({ kind: 'jury_adopt', draftId: SESSION, sourceVersionId: REQUEST })).toEqual(invalid);
    expect(await status(compareBody, deps({ databaseHost: { declared: undefined, actual: 'db.test' } }))).toEqual([503, { error: 'TURN_DATABASE_MISMATCH' }]);
    expect(await status(compareBody, deps({ authenticate: async () => null }))).toEqual([401, { error: 'TURN_UNAUTHENTICATED' }]);
    expect(await status(compareBody, deps({ rateLimited: async () => { throw new Error('redis down'); } }))).toEqual([429, { error: 'TURN_RATE_LIMITED' }]);
    expect(m.allowed).not.toHaveBeenCalled();
  });

  it('a compare is priced as its turn prices it, with the history the turn will see, and creates nothing', async () => {
    const [code, body] = await status(compareBody);
    expect(code).toBe(200);
    expect(body).toEqual({ credits: 4, tooLarge: [], overBudget: false, columns: [{ modelId: MODEL_A, credits: 2, usd: '0.02' },
      { modelId: MODEL_B, credits: 2, usd: '0.02' }] });
    expect(m.price.mock.calls[0]![0].parts).toMatchObject({ positioningFallback: true, history: [{ role: 'user', text: 'hi' }] });
    expect(m.compare).not.toHaveBeenCalled();
  });

  it('refusals keep their code: a switch off or a plan without compare is 403, a Skill for social media without a positioning is 403', async () => {
    m.allowed.mockRejectedValueOnce(new Error('FUSION_COMPARE_FORBIDDEN'));
    expect(await status(compareBody)).toEqual([403, { error: 'FUSION_COMPARE_FORBIDDEN' }]);
    m.allowed.mockRejectedValueOnce(new Error('FUSION_COMPARE_TOO_FEW'));
    expect(await status(compareBody)).toEqual([400, { error: 'FUSION_COMPARE_TOO_FEW' }]);
    m.parts.mockResolvedValueOnce({ skill: { socialMedia: true }, workspace: [], references: [], question: 'Which?' });
    m.admit.mockResolvedValueOnce({ history: [], positioned: false });
    expect(await status(compareBody)).toEqual([403, { error: 'POSITIONING_REQUIRED' }]);
    m.configuration.mockResolvedValueOnce({ data: [{ key: CORE_PATH_SETTING, value: { enabled: false, stopLoss: {} } }], error: null });
    expect(await status(compareBody)).toEqual([503, { error: 'TURN_CORE_DISABLED' }]);
  });

  it('a jury answers with the price and the hold of its start', async () => {
    m.estimate.mockResolvedValue({ estimateCredits: 1500, holdCredits: 40, requiredCredits: 1540, maxRounds: 2, reviewers: 3 });
    expect(await status({ kind: 'jury', draftId: SESSION, sourceVersionId: REQUEST })).toEqual([200,
      { estimateCredits: 1500, holdCredits: 40, requiredCredits: 1540, maxRounds: 2, reviewers: 3 }]);
    expect(m.estimate).toHaveBeenCalledWith({ draftId: SESSION, sourceVersionId: REQUEST });
    m.estimate.mockRejectedValueOnce(new Error('FUSION_REVIEW_DISABLED'));
    expect(await status({ kind: 'jury', draftId: SESSION, sourceVersionId: REQUEST })).toEqual([403, { error: 'FUSION_REVIEW_DISABLED' }]);
  });
});

describe('POST /api/turn/compare', () => {
  const start = (body: unknown, d = deps()) => handleCompareStart(post(body), d);
  const valid = { sessionId: SESSION, question: ' Which? ', modelIds: [MODEL_A, MODEL_B], requestId: REQUEST, shown };

  it('needs the quote the user saw, and the entry checks', async () => {
    const without: Partial<typeof valid> = { ...valid };
    delete without.shown;
    expect((await start(without)).status).toBe(400);
    expect((await start({ ...valid, shown: { credits: 4, columns: [] } })).status).toBe(400);
    expect((await start({ ...valid, shown: { ...shown, extra: 1 } })).status).toBe(400);
    expect((await start(valid, deps({ authenticate: async () => null }))).status).toBe(401);
    expect((await start(valid, deps({ rateLimited: async () => true }))).status).toBe(429);
    expect(m.compare).not.toHaveBeenCalled();
  });

  it('hands the quote to the turn and streams it', async () => {
    m.compare.mockImplementation(async (_deps, input, emit) => {
      expect(input).toMatchObject({ actorId: 'actor-1', sessionId: SESSION, requestId: REQUEST, modelIds: [MODEL_A, MODEL_B], shown });
      await input.parts();
      emit({ type: 'result', turnId: 3, compareId: SESSION, chargedCredits: 1, settlement: 'done' });
    });
    const res = await start(valid);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('event: result');
    expect(m.parts.mock.calls[0]![1]).toEqual({ sessionId: SESSION, question: 'Which?', skill: undefined });
  });
});
