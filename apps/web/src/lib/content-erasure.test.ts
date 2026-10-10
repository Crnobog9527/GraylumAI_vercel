/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import {
  buildContentErasureLines, classifyErasureError, confirmContentErasure, describeErasureResult, forgetLocalCopies,
  refreshAfterErasure, type ContentErasurePreview, type ContentErasureResult,
} from './content-erasure';

const id = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
function preview(patch: Partial<ContentErasurePreview> = {}): ContentErasurePreview {
  return {
    kind: 'session', id, alreadyDeleted: false, affectedExecutions: 3, preservedSavedVersions: 0,
    affectedSources: [], previewHash: hash, ...patch,
  };
}
function result(patch: Partial<ContentErasureResult> = {}): ContentErasureResult {
  return {
    kind: 'session', id, status: 'deleted', alreadyDeleted: false, preservedSavedVersions: 0,
    financialReviewCount: 0, ...patch,
  };
}
const texts = (value: ContentErasurePreview) => buildContentErasureLines(value).map((line) => line.text).join('\n');
const trpcError = (message: string, code?: string) => Object.assign(new Error(message), { data: { code } });

describe('content erasure impact lines', () => {
  it('says what each kind permanently removes, that it cannot be undone and that fees are not refunded', () => {
    expect(texts(preview({ kind: 'answer' }))).toContain('你的提问会保留');
    expect(texts(preview({ kind: 'session' }))).toContain('全部消息');
    expect(texts(preview({ kind: 'artifact' }))).toContain('全部历史版本');
    expect(texts(preview({ kind: 'content' }))).toContain('不只是当前这一版');
    const all = texts(preview());
    expect(all).toContain('无法恢复');
    expect(all).toContain('不会退还已产生的费用');
  });

  it('always explains retained results with 来源已不可用 and never promises an exact retained count', () => {
    for (const preserved of [0, 1, 7]) {
      const all = texts(preview({ preservedSavedVersions: preserved }));
      expect(all).toContain('来源已不可用');
      expect(all).not.toContain(String(preserved) + ' ');
      expect(all).not.toMatch(/保留\s*\d/);
    }
  });

  it('groups positioning dependents by type before confirming', () => {
    const all = texts(preview({ kind: 'artifact', affectedSources: [
      { kind: 'account', id: 'a1' }, { kind: 'account', id: 'a2' }, { kind: 'work_item', id: 'w' },
      { kind: 'content', id: 'c' },
    ] }));
    expect(all).toContain('有 2 个账号定位、1 条选题工作、1 份稿件以它为来源');
    expect(all).toContain('需要重新选择来源或复核');
    expect(texts(preview())).not.toContain('以它为来源');
  });
});

describe('content erasure results and errors', () => {
  it('never reports review_required as fully cleaned', () => {
    expect(describeErasureResult(result())).toBe('已永久删除。');
    expect(describeErasureResult(result({ alreadyDeleted: true }))).toContain('之前已经');
    const review = describeErasureResult(result({ status: 'review_required', financialReviewCount: 2 }));
    expect(review).toContain('仍在核对');
    expect(review).not.toContain('已永久删除');
  });

  it('maps every backend code to friendly Chinese without exposing the code', () => {
    const cases: Array<[unknown, string, string]> = [
      [trpcError('CONTENT_NOT_FOUND', 'NOT_FOUND'), 'message', '没有权限'],
      [trpcError('CONTENT_ERASED', 'PRECONDITION_FAILED'), 'gone', '已经永久删除'],
      [trpcError('CONTENT_ERASURE_PREVIEW_CHANGED', 'CONFLICT'), 'changed', '重新读取'],
      [trpcError('CONTENT_ERASURE_BUSY', 'CONFLICT'), 'message', '没有删除任何内容'],
      [trpcError('CONTENT_ERASURE_UNAVAILABLE', 'SERVICE_UNAVAILABLE'), 'message', '不要当作已删除'],
      [trpcError('relation "x" does not exist'), 'message', '暂未确认'],
      [trpcError('Too many', 'TOO_MANY_REQUESTS'), 'message', '太频繁'],
      [trpcError('UNAUTHORIZED', 'UNAUTHORIZED'), 'message', '重新登录'],
    ];
    for (const [error, type, text] of cases) {
      const failure = classifyErasureError(error, 'confirm');
      expect(failure.type).toBe(type);
      expect(failure.message).toContain(text);
      expect(failure.message).not.toMatch(/CONTENT_|[A-Z]{4,}/);
    }
    expect(classifyErasureError(new Error('boom'), 'preview').message).toContain('暂时无法读取删除影响');
  });
});

describe('cache and local copy invalidation', () => {
  it('invalidates OPC, Runtime and preview caches together', async () => {
    const utils = {
      opc: { invalidate: vi.fn(async () => undefined) },
      runtime: { invalidate: vi.fn(async () => undefined) },
      account: { contentErasurePreview: { invalidate: vi.fn(async () => undefined) } },
    };
    await refreshAfterErasure(utils);
    expect(utils.opc.invalidate).toHaveBeenCalledOnce();
    expect(utils.runtime.invalidate).toHaveBeenCalledOnce();
    expect(utils.account.contentErasurePreview.invalidate).toHaveBeenCalledOnce();
  });

  it('drops local drafts and pending requests that name a deleted id in the key or the stored value', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const data = new Map([
      ['opc-runtime-input:' + id, 'draft'], ['opc-runtime-scroll:actor:' + id, '9'],
      ['opc-library-final:work-1', JSON.stringify({ sourceContentId: other, body: 'private text' })],
      ['opc-video-operation:session-1', JSON.stringify({ script: { executionId: id } })],
      ['other', JSON.stringify({ sourceContentId: 'unrelated' })],
    ]);
    const store = {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      removeItem: (key: string) => { data.delete(key); },
    } as unknown as Storage;
    const broken = { get length(): number { throw new Error('denied'); } } as unknown as Storage;
    forgetLocalCopies([id, other, ''], [store, broken, null]);
    expect([...data.keys()]).toEqual(['other']);
  });
});

describe('confirmContentErasure', () => {
  it('confirms with the previewed hash and refreshes everything afterwards', async () => {
    const confirm = vi.fn(async () => result());
    const afterErasure = vi.fn(async () => undefined);
    const outcome = await confirmContentErasure({ confirm, afterErasure }, preview());
    expect(confirm).toHaveBeenCalledWith({ kind: 'session', id, previewHash: hash, acknowledged: true });
    expect(afterErasure).toHaveBeenCalledWith({ kind: 'session', id });
    expect(outcome).toEqual({ type: 'done', message: '已永久删除。', reviewRequired: false });
  });

  it('keeps review_required visible as unfinished financial review', async () => {
    const outcome = await confirmContentErasure({
      confirm: async () => result({ status: 'review_required', financialReviewCount: 1 }), afterErasure: async () => undefined,
    }, preview());
    expect(outcome).toMatchObject({ type: 'done', reviewRequired: true });
  });

  it('treats an already deleted object as gone and still refreshes the caches', async () => {
    const afterErasure = vi.fn(async () => undefined);
    const outcome = await confirmContentErasure({
      confirm: async () => { throw trpcError('CONTENT_ERASED', 'PRECONDITION_FAILED'); }, afterErasure,
    }, preview());
    expect(outcome.type).toBe('done');
    expect(afterErasure).toHaveBeenCalledOnce();
  });

  it('asks for a fresh preview on a changed scope and reports busy or unknown results without refreshing as deleted', async () => {
    for (const [message, type] of [
      ['CONTENT_ERASURE_PREVIEW_CHANGED', 'changed'], ['CONTENT_ERASURE_BUSY', 'error'],
      ['CONTENT_NOT_FOUND', 'error'], ['CONTENT_ERASURE_UNAVAILABLE', 'error'],
    ] as const) {
      const afterErasure = vi.fn(async () => undefined);
      const outcome = await confirmContentErasure({
        confirm: async () => { throw trpcError(message); }, afterErasure,
      }, preview());
      expect(outcome.type).toBe(type);
      expect(afterErasure).not.toHaveBeenCalled();
    }
  });
});
