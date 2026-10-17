/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnEvent, AgentTurnOutcome } from '@repo/api/src/shared/agentTurn';
import { liveReplyController } from '@/app/positioning/[draftId]/live-reply-controller';
import type { LiveReply } from '@/app/positioning/[draftId]/agent-turn-display';
import { definiteRefusalNotice, isLibrarySourceDeleted, libraryReferenceRefusal, runtimeAdmissionNotice, SOURCE_DELETED_NOTICE } from './gate-notices';
import { runtimeTurnNotices, type RuntimeTurn } from './runtime-notices';
import {
  draftReferencesKey, openingDraftWithReferences, readPending, rememberPending, requestIdFor, saveDraftReferences,
} from './send-input';
import { runStreamedExecution } from './use-runtime-stream';

// UI-B wiring of LIB-4b (#1022): references travel with the draft, the pending send and the request id.
const weekly = { documentId: '11111111-1111-4111-8111-111111111111', version: 2, label: '周报.md' };
const monthly = { documentId: '22222222-2222-4222-8222-222222222222', version: 5, label: '月报.pdf' };

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); } };
}

describe('draft and pending references', () => {
  it('keeps the draft references next to its text and drops the key when there are none', () => {
    const storage = memoryStorage();
    storage.setItem('opc-runtime-input:s', '对比 @周报.md');
    saveDraftReferences(storage, 's', [weekly]);
    expect(openingDraftWithReferences(storage, 's')).toEqual({ text: '对比 @周报.md', references: [weekly] });
    saveDraftReferences(storage, 's', []);
    expect(storage.map.has(draftReferencesKey('s'))).toBe(false);
  });

  it('a send moves its references into the pending record; a reload brings them back before newer ones', () => {
    const storage = memoryStorage();
    saveDraftReferences(storage, 's', [weekly]);
    rememberPending(storage, 's', { requestId: 'r1', text: '看 @周报.md', input: '看 @周报.md', references: [weekly] });
    expect(storage.map.has(draftReferencesKey('s'))).toBe(false);
    expect(readPending(storage, 's')?.references).toEqual([weekly]);
    // Typed after the send: another reference.
    storage.setItem('opc-runtime-input:s', '还有 @月报.pdf');
    saveDraftReferences(storage, 's', [monthly, weekly]);
    expect(openingDraftWithReferences(storage, 's')).toEqual({
      text: '看 @周报.md\n\n还有 @月报.pdf', references: [weekly, monthly],
    });
    // Restored once: a second reload adds nothing.
    expect(openingDraftWithReferences(storage, 's').references).toEqual([weekly, monthly]);
  });

  it('a send without references stores the same record as before UI-B', () => {
    const storage = memoryStorage();
    rememberPending(storage, 's', { requestId: 'r1', text: '你好', input: '你好', references: [] }, 7);
    expect(JSON.parse(storage.map.get('opc-runtime-pending:s')!)).toEqual({ requestId: 'r1', text: '你好', input: '你好', at: 7 });
  });

  it('drops malformed stored references instead of sending them', () => {
    const storage = memoryStorage();
    storage.setItem(draftReferencesKey('s'), JSON.stringify([weekly, { documentId: 'x', version: 0, label: 'a' }, 'junk']));
    expect(openingDraftWithReferences(storage, 's').references).toEqual([weekly]);
    storage.setItem(draftReferencesKey('s'), 'not json');
    expect(openingDraftWithReferences(storage, 's').references).toEqual([]);
  });

  it('the same text with other references or another version is a new request id (else RUNTIME_REQUEST_CONFLICT)', () => {
    const storage = memoryStorage();
    rememberPending(storage, 's', { requestId: 'r1', text: '看 @周报.md', input: '看 @周报.md', references: [weekly] });
    const pending = readPending(storage, 's');
    const fresh = () => 'fresh';
    expect(requestIdFor(null, pending, '看 @周报.md', fresh, [weekly])).toBe('r1');
    expect(requestIdFor('r1', pending, '看 @周报.md', fresh, [weekly])).toBe('r1');
    expect(requestIdFor(null, pending, '看 @周报.md', fresh, [{ ...weekly, version: 3 }])).toBe('fresh');
    expect(requestIdFor('r1', pending, '看 @周报.md', fresh, [weekly, monthly])).toBe('fresh');
    expect(requestIdFor(null, pending, '看 @周报.md', fresh)).toBe('fresh');
    // A pending send from before UI-B has no references: the same text without references still replays.
    rememberPending(storage, 's', { requestId: 'r2', text: '你好', input: '你好' });
    expect(requestIdFor(null, readPending(storage, 's'), '你好', fresh, [])).toBe('r2');
  });
});

describe('library reference refusals', () => {
  const refusal = (message: string, code = 'PRECONDITION_FAILED', path = 'runtime.prepare') =>
    Object.assign(new Error(message), { data: { code, path, httpStatus: code === 'BAD_REQUEST' ? 400 : 412 } });

  it.each([
    ['LIB_REFERENCE_INVALID', 'BAD_REQUEST', '引用的文档格式不对，请重新选择；未扣费。'],
    ['LIB_REFERENCE_LIMIT', 'BAD_REQUEST', '每条消息最多引用 5 篇文档；未扣费。'],
    ['LIB_REFERENCE_NOT_FOUND', 'PRECONDITION_FAILED', '引用的文档不存在或已删除，请重新选择；未扣费。'],
    ['LIB_REFERENCE_NOT_READY', 'PRECONDITION_FAILED', '引用的文档还没处理好，请稍后再发；未扣费。'],
    ['LIB_REFERENCE_STALE', 'PRECONDITION_FAILED', '引用的文档已经更新，请重新选择；未扣费。'],
    ['LIB_REFERENCE_UNSUPPORTED', 'PRECONDITION_FAILED', '这里不能引用资料库文档；未扣费。'],
    ['LIB_REFERENCE_DISABLED', 'PRECONDITION_FAILED', '引用资料库文档的功能还没有开放；未扣费。'],
    ['LIB_REFERENCE_CAPACITY', 'PRECONDITION_FAILED', '本轮内容加上文档读取超过模型容量，请缩短输入或少引用一些；未扣费。'],
  ])('%s shows the server text without the code', (code, trpcCode, text) => {
    const cause = refusal(code + '：' + text, trpcCode);
    expect(runtimeAdmissionNotice(cause)).toBe(text);
    expect(libraryReferenceRefusal(cause)).toEqual({ code, notice: text });
    // A definite refusal: the page restores the input instead of saying the outcome is unknown.
    expect(definiteRefusalNotice(cause, ['runtime.prepare'])).not.toBeNull();
  });

  it('only reads runtime.prepare refusals that carry the code prefix', () => {
    expect(libraryReferenceRefusal(refusal('LIB_REFERENCE_STALE：已更新', 'PRECONDITION_FAILED', 'runtime.execute'))).toBeNull();
    expect(libraryReferenceRefusal(refusal('其他原因'))).toBeNull();
    expect(libraryReferenceRefusal('LIB_REFERENCE_STALE：已更新')).toBeNull();
  });

  it('recognises the mid-stream deletion', () => {
    expect(isLibrarySourceDeleted(new Error('LIB_SOURCE_DELETED：本轮引用的文档已删除或已更新，这一轮回答不再显示。'))).toBe(true);
    expect(isLibrarySourceDeleted(new Error('STREAM_INTERRUPTED'))).toBe(false);
  });
});

describe('a referenced document deleted while the turn runs', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  const delta = (text: string, offset: number): AgentTurnEvent => ({ type: 'textDelta', text, offset, rev: 1, source: 'assistant' });

  it('drops the text already shown instead of keeping half an answer, and tells the page', async () => {
    const shown: Array<LiveReply | null> = [];
    const live = liveReplyController({ draftId: 'runtime:s', storage: () => null, show: reply => shown.push(reply) });
    const handlers = { onResult: vi.fn(), refreshBalance: vi.fn(), onSourceDeleted: vi.fn() };
    const deleted = Object.assign(new Error('LIB_SOURCE_DELETED：本轮引用的文档已删除或已更新，这一轮回答不再显示。'),
      { data: { code: 'PRECONDITION_FAILED', httpStatus: 412 } });
    async function* events() { yield delta('前半段回答', 0); throw deleted; }
    await expect(runStreamedExecution(live, async () => events(), ID, handlers)).rejects.toBe(deleted);
    expect(shown.some(reply => reply?.text === '前半段回答')).toBe(true);
    expect(live.current()).toBeNull();
    expect(shown.at(-1)).toBeNull();
    expect(handlers.onSourceDeleted).toHaveBeenCalledWith(ID);
    expect(handlers.onResult).not.toHaveBeenCalled();
    expect(handlers.refreshBalance).toHaveBeenCalledTimes(1);
  });

  it('a result that says the source was deleted clears the shown text the same way', async () => {
    const shown: Array<LiveReply | null> = [];
    const live = liveReplyController({ draftId: 'runtime:s', storage: () => null, show: reply => shown.push(reply) });
    const handlers = { onResult: vi.fn(), refreshBalance: vi.fn(), onSourceDeleted: vi.fn() };
    const outcome = { state: 'cancelled', unavailable: 'source_deleted' } as unknown as AgentTurnOutcome;
    async function* events(): AsyncGenerator<AgentTurnEvent> { yield delta('前半段回答', 0); yield { type: 'result', result: outcome }; }
    await expect(runStreamedExecution(live, async () => events(), ID, handlers)).resolves.toBe(outcome);
    expect(shown.some(reply => reply?.text === '前半段回答')).toBe(true);
    expect(live.current()).toBeNull();
    expect(handlers.onSourceDeleted).toHaveBeenCalledWith(ID);
  });

  it('a lost stream for any other reason still keeps its text waiting', async () => {
    const live = liveReplyController({ draftId: 'runtime:s', storage: () => null, show: () => {} });
    const handlers = { onResult: vi.fn(), refreshBalance: vi.fn(), onSourceDeleted: vi.fn() };
    async function* events() { yield delta('部分', 0); }
    await expect(runStreamedExecution(live, async () => events(), ID, handlers)).rejects.toThrow();
    expect(live.current()).toMatchObject({ text: '部分', phase: 'waiting' });
    expect(handlers.onSourceDeleted).not.toHaveBeenCalled();
  });

  const turn = (extra: Partial<RuntimeTurn> = {}): RuntimeTurn => ({
    executionId: 'e1', state: 'running', primaryBody: null, organizerComplete: null, needsTask: false, unavailableReason: null, ...extra,
  });
  const ctx = (extra = {}) => ({ busy: true, capacity: false, stopping: false, onRetry: vi.fn(), onStop: vi.fn(), ...extra });

  it('the turn says the document was deleted, with no 重试 or 停止, both live and after a refresh', () => {
    expect(runtimeTurnNotices(turn(), ctx({ sourceDeleted: true })))
      .toEqual([{ id: 'e1:source-deleted', tone: 'warning', text: SOURCE_DELETED_NOTICE }]);
    expect(runtimeTurnNotices(turn({ state: 'cancelled', unavailableReason: 'source_deleted' }), ctx({ busy: false })))
      .toEqual([{ id: 'e1:source-deleted', tone: 'warning', text: SOURCE_DELETED_NOTICE }]);
    expect(runtimeTurnNotices(turn(), ctx())[0].text).not.toBe(SOURCE_DELETED_NOTICE);
  });
});
