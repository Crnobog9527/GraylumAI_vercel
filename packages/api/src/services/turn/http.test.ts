/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDeps } from './chat';
import { handleTurnRequest, type TurnHttpDeps } from './http';

const run = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());
const mentor = vi.hoisted(() => vi.fn());
const compare = vi.hoisted(() => vi.fn());
const juryStart = vi.hoisted(() => vi.fn());
const loadParts = vi.hoisted(() => vi.fn());
vi.mock('./chat', () => ({ runChatTurn: run }));
vi.mock('./mentor', () => ({ runMentorTurn: mentor }));
vi.mock('./compare', () => ({ runCompareTurn: compare }));
vi.mock('./jury', async original => ({ ...await original<object>(), juryTurn: () => ({ start: juryStart }) }));
vi.mock('../fusion/compareLoad', async original => ({ ...await original<object>(), loadCompareTurnParts: loadParts }));
vi.mock('./report', async original => ({ ...await original<object>(), runReportTurn: report }));

const SESSION = '00000000-0000-4000-8000-000000000001', REQUEST = '00000000-0000-4000-8000-000000000002';
const DRAFT = '00000000-0000-4000-8000-000000000003', VERSION = '00000000-0000-4000-8000-000000000004';
const post = (body: unknown) => new Request('https://app.test/api/turn', { method: 'POST', body: JSON.stringify(body) });
const valid = { kind: 'chat', sessionId: SESSION, requestId: REQUEST, text: 'Hello' };
const deps = (over: Partial<TurnHttpDeps> = {}): TurnHttpDeps => ({
  authenticate: async () => 'actor-1', rateLimited: async () => false,
  databaseHost: { declared: 'db.test', actual: 'db.test' }, chat: { newWork: {} } as ChatDeps,
  userClient: () => ({}) as never, handReview: () => {}, ...over,
});

describe('POST /api/turn entry (CORE-PATH-V2 2.2, 2.8)', () => {
  beforeEach(() => { run.mockReset(); report.mockReset(); compare.mockReset(); juryStart.mockReset(); loadParts.mockReset(); });

  it('refuses before any turn work: bad shape, wrong or undeclared database host, no account, rate limited', async () => {
    const status = async (body: unknown, d: TurnHttpDeps) => {
      const res = await handleTurnRequest(post(body), d);
      return [res.status, (await res.json()).error];
    };
    expect(await status({ ...valid, kind: 'report' }, deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status({ ...valid, text: '   ' }, deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status({ ...valid, extra: 1 }, deps())).toEqual([400, 'TURN_REQUEST_INVALID']);
    expect(await status(valid, deps({ databaseHost: { declared: 'db.other', actual: 'db.test' } }))).toEqual([503, 'TURN_DATABASE_MISMATCH']);
    expect(await status(valid, deps({ databaseHost: { declared: undefined, actual: 'db.test' } }))).toEqual([503, 'TURN_DATABASE_MISMATCH']);
    expect(await status(valid, deps({ authenticate: async () => null }))).toEqual([401, 'TURN_UNAUTHENTICATED']);
    expect(await status(valid, deps({ authenticate: async () => { throw new Error('auth down'); } }))).toEqual([401, 'TURN_UNAUTHENTICATED']);
    expect(await status(valid, deps({ rateLimited: async () => true }))).toEqual([429, 'TURN_RATE_LIMITED']);
    // A limiter that cannot answer refuses rather than letting the turn through.
    expect(await status(valid, deps({ rateLimited: async () => { throw new Error('redis down'); } }))).toEqual([429, 'TURN_RATE_LIMITED']);
    expect(run).not.toHaveBeenCalled();
  });

  it('streams the turn as events for the signed-in account, and an unknown error text never reaches the client', async () => {
    run.mockImplementation(async (_deps, input, emit) => {
      emit({ type: 'opened', turnId: 7, reservedCredits: 40, replay: false });
      emit({ type: 'text', delta: 'Hi' });
      emit({ type: 'error', code: 'relation "turns" does not exist', turnId: 7 });
      expect(input).toEqual({ actorId: 'actor-1', sessionId: SESSION, requestId: REQUEST, text: 'Hello' });
    });
    const res = await handleTurnRequest(post(valid), deps());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body.split('\n\n').filter(Boolean).map(chunk => chunk.split('\n')[0])).toEqual(['event: opened', 'event: text', 'event: error']);
    expect(body).toContain('"code":"TURN_FAILED"');
    expect(body).not.toContain('relation');
  });

  it('carries what the composer chose for the message, and refuses a malformed reference (V2-10)', async () => {
    run.mockResolvedValue(undefined);
    const documentId = '00000000-0000-4000-8000-000000000009', moduleId = '00000000-0000-4000-8000-000000000008';
    const references = [{ kind: 'library_document', documentId, version: 2 }];
    await (await handleTurnRequest(post({ ...valid, moduleId, references }), deps())).text();
    expect(run.mock.calls[0]![1]).toMatchObject({ chosen: { moduleId, references } });
    expect((await handleTurnRequest(post({ ...valid, references: [{ documentId }] }), deps())).status).toBe(400);
  });

  it('keeps the turn running to its close after the client goes away', async () => {
    let finish!: () => void, closed = false;
    run.mockImplementation(async (_deps, _input, emit) => {
      emit({ type: 'opened', turnId: 1, reservedCredits: 1, replay: false });
      await new Promise<void>(resolve => { finish = resolve; });
      emit({ type: 'text', delta: 'late' });
      closed = true;
    });
    const res = await handleTurnRequest(post(valid), deps());
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    finish();
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('a report (V2-7a) gets its own input and hears when the page drops the stream; a chat never does', async () => {
    let gone: AbortSignal | undefined;
    report.mockImplementation(async (_deps, input, emit, signal) => {
      gone = signal;
      expect(input).toEqual({ actorId: 'actor-1', sessionId: SESSION, requestId: REQUEST, moduleId: SESSION, projectId: SESSION,
        roundId: SESSION, acceptedCredits: 500 });
      emit({ type: 'opened', turnId: 3, reservedCredits: 680, replay: false });
      await new Promise(resolve => signal.addEventListener('abort', resolve));
    });
    const body = { kind: 'report', sessionId: SESSION, requestId: REQUEST, moduleId: SESSION, projectId: SESSION, roundId: SESSION,
      acceptedCredits: 500 };
    expect((await handleTurnRequest(post({ ...body, acceptedCredits: undefined }), deps())).status).toBe(400);
    const res = await handleTurnRequest(post(body), deps());
    const reader = res.body!.getReader();
    await reader.read();
    expect(gone?.aborted).toBe(false);
    await reader.cancel();
    expect(gone?.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('hands a mentor request its Refresh grant', async () => {
    mentor.mockReset();
    mentor.mockImplementation(async (_deps: unknown, _input: unknown, emit: (e: unknown) => void) => {
      emit({ type: 'error', code: 'TURN_FAILED' });
    });
    const refresh = '00000000-0000-4000-8000-000000000003';
    const res = await handleTurnRequest(post({ kind: 'mentor', sessionId: SESSION, requestId: REQUEST, moduleId: '00000000-0000-4000-8000-000000000004',
      stepId: 'step-0', text: 'Refresh it', organizeAfter: true, researchRefreshId: refresh }), deps());
    await res.text();
    expect(mentor.mock.calls[0]![1]).toMatchObject({ researchRefreshId: refresh });
  });

  const comparing = { kind: 'compare', sessionId: SESSION, requestId: REQUEST, question: ' Which? ', modelIds: [DRAFT, VERSION] };
  const reviewing = { kind: 'jury', requestId: REQUEST, draftId: DRAFT, sourceVersionId: VERSION, acceptedCredits: 1500 };

  it('V2-7b: compare and jury share the entry checks; nothing outside their shape reaches a turn', async () => {
    const status = async (body: unknown, d = deps()) => {
      const res = await handleTurnRequest(post(body), d);
      return [res.status, (await res.json()).error];
    };
    const invalid = [400, 'TURN_REQUEST_INVALID'];
    expect(await status({ ...comparing, question: '  ' })).toEqual(invalid);
    expect(await status({ ...comparing, modelIds: [] })).toEqual(invalid);
    expect(await status({ ...comparing, modelIds: Array(9).fill(DRAFT) })).toEqual(invalid);
    expect(await status({ ...comparing, modelIds: ['gpt'] })).toEqual(invalid);
    expect(await status({ ...reviewing, sessionId: SESSION })).toEqual(invalid);
    expect(await status({ ...reviewing, acceptedCredits: 0 })).toEqual(invalid);
    // Adopting a revised report is not a turn (Owner 10-20): no such kind.
    expect(await status({ ...reviewing, kind: 'jury_adopt' })).toEqual(invalid);
    expect(await status(comparing, deps({ authenticate: async () => null }))).toEqual([401, 'TURN_UNAUTHENTICATED']);
    expect(await status(reviewing, deps({ rateLimited: async () => true }))).toEqual([429, 'TURN_RATE_LIMITED']);
    expect(compare).not.toHaveBeenCalled();
    expect(juryStart).not.toHaveBeenCalled();
  });

  it('V2-7b: a compare streams its columns, its parts read only when the executor asks', async () => {
    loadParts.mockResolvedValue({ question: 'Which?' });
    compare.mockImplementation(async (_deps, input, emit) => {
      expect(loadParts).not.toHaveBeenCalled();
      expect(await input.parts()).toEqual({ question: 'Which?' });
      expect(input).toMatchObject({ actorId: 'actor-1', sessionId: SESSION, requestId: REQUEST, modelIds: [DRAFT, VERSION] });
      emit({ type: 'opened', turnId: 3, compareId: DRAFT, reservedCredits: 2, replay: false });
      emit({ type: 'column', index: 1, delta: 'A' });
      emit({ type: 'result', turnId: 3, compareId: DRAFT, chargedCredits: 1, settlement: 'done' });
    });
    const text = await (await handleTurnRequest(post(comparing), deps())).text();
    expect(text).toContain('event: column');
    expect(text).toContain('"compareId"');
    expect(loadParts.mock.calls[0]![1]).toEqual({ sessionId: SESSION, question: 'Which?', skill: undefined });
  });

  it('V2-7b: a jury start answers once and hands the review to the server; an ended or refused one is not handed over', async () => {
    const handReview = vi.fn();
    const view = { reviewId: DRAFT, turnId: 9, state: 'paused', config: { fixedPrice: { credits: 1500, holdCredits: 40 } } };
    juryStart.mockResolvedValueOnce(view);
    const text = await (await handleTurnRequest(post(reviewing), deps({ handReview }))).text();
    expect(juryStart).toHaveBeenCalledWith({ requestId: REQUEST, draftId: DRAFT, sourceVersionId: VERSION, acceptedCredits: 1500 });
    expect(text).toContain('event: review');
    expect(text).toContain('"reservedCredits":1540');
    expect(handReview).toHaveBeenCalledExactlyOnceWith(DRAFT);

    handReview.mockClear();
    juryStart.mockResolvedValueOnce({ ...view, state: 'incomplete' });
    expect(await (await handleTurnRequest(post(reviewing), deps({ handReview }))).text()).toContain('"state":"incomplete"');
    juryStart.mockRejectedValueOnce(new Error('FUSION_REVIEW_ESTIMATE_CHANGED'));
    expect(await (await handleTurnRequest(post(reviewing), deps({ handReview }))).text()).toContain('FUSION_REVIEW_ESTIMATE_CHANGED');
    juryStart.mockResolvedValueOnce({ ...view, turnId: null });
    expect(await (await handleTurnRequest(post(reviewing), deps({ handReview }))).text()).toContain('TURN_REQUEST_CONFLICT');
    expect(handReview).not.toHaveBeenCalled();
  });
});
