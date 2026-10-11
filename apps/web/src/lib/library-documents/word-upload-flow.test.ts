/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { WORD_MIME } from './format';
import type { UploadAttempt, UploadFailure } from './upload-flow';
import { prepareWord, runWordUpload, type WordUploadApi } from './word-upload-flow';

const file = new Blob(['PK\u0003\u0004word']);
const prepared = { text: new Blob(['# 标题\n正文']), headings: [{ offset: 0, level: 1, text: '标题' }] };
const link = (name: string) => ({ signedUrl: 'https://s/' + name + '?token=t' });
function setup(overrides: Partial<WordUploadApi> = {}) {
  const api: WordUploadApi = {
    begin: vi.fn(async () => ({ documentId: 'doc-1', status: 'uploading', upload: link('original') })),
    beginText: vi.fn(async () => ({ documentId: 'doc-1', status: 'uploading', upload: link('text') })),
    complete: vi.fn(async () => ({ status: 'ready' })),
    abandon: vi.fn(async () => ({ status: 'deleting' })),
    put: vi.fn(async (_url, _file, _type, progress) => { progress(1); }),
    ...overrides,
  };
  let n = 0;
  const run = (attempt: UploadAttempt = { requestId: 'req-0', resume: 'begin' }) => runWordUpload(api, {
    file, filename: '报告.docx', purpose: 'reference', prepared, attempt, newId: () => 'req-' + ++n, onStage: () => {},
  });
  return { api, run };
}
const fail = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as UploadFailure; }
  throw new Error('expected failure');
};
const definite = (code: string) => Object.assign(new Error(code), { data: { code: 'BAD_REQUEST' } });

describe('runWordUpload (#796 two-object contract)', () => {
  it('sends the original, then the extracted text, then completes with headings', async () => {
    const { api, run } = setup();
    await expect(run()).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledWith(expect.objectContaining({ contentType: WORD_MIME, filename: '报告.docx', purpose: 'reference' }));
    const puts = vi.mocked(api.put).mock.calls;
    expect(puts[0].slice(0, 3)).toEqual(['https://s/original?token=t', file, WORD_MIME]);
    expect(puts[1].slice(0, 3)).toEqual(['https://s/text?token=t', prepared.text, 'text/plain']);
    expect(api.beginText).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(api.complete).toHaveBeenCalledWith({ documentId: 'doc-1', headings: prepared.headings });
    // The text grant is requested only after the original is stored.
    expect(vi.mocked(api.beginText).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(api.put).mock.invocationCallOrder[0]);
  });
  it('resumes the text stage after an unknown second-stage result, without a new begin', async () => {
    const beginText = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue({ documentId: 'doc-1', status: 'uploading', upload: link('text') });
    const { api, run } = setup({ beginText });
    const failure = await fail(run());
    expect(failure.retry).toEqual({ requestId: 'req-0', documentId: 'doc-1', resume: 'text' });
    await expect(run(failure.retry)).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledTimes(1);
  });
  it('releases and starts over when the text link went to an earlier attempt', async () => {
    const beginText = vi.fn().mockResolvedValueOnce({ documentId: 'doc-1', status: 'uploading', upload: null })
      .mockResolvedValue({ documentId: 'doc-2', status: 'uploading', upload: link('text') });
    const begin = vi.fn().mockResolvedValueOnce({ documentId: 'doc-1', status: 'uploading', upload: link('a') })
      .mockResolvedValue({ documentId: 'doc-2', status: 'uploading', upload: link('b') });
    const { api, run } = setup({ begin, beginText });
    await expect(run()).resolves.toEqual({ documentId: 'doc-2' });
    expect(api.abandon).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(begin.mock.calls[1][0].requestId).toBe('req-1');
  });
  it('releases the row after a definite text-stage rejection', async () => {
    const { api, run } = setup({ beginText: vi.fn(async () => { throw definite('LIBRARY_UPLOAD_UNAVAILABLE'); }) });
    const failure = await fail(run());
    expect(api.abandon).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(failure.retry).toMatchObject({ resume: 'begin' });
    expect(failure.retry.releaseFirst).toBeUndefined();
  });
  it('owes the release to the retry when a failed text transfer cannot be released', async () => {
    const put = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('UPLOAD_NETWORK'));
    const { run } = setup({ put, abandon: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    expect((await fail(run())).retry).toMatchObject({ resume: 'begin', releaseFirst: 'doc-1' });
  });
  it('re-checks after an unknown completion, and releases after a definite one', async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue({ status: 'ready' });
    const unknown = setup({ complete });
    const failure = await fail(unknown.run());
    expect(failure.retry).toEqual({ requestId: 'req-0', documentId: 'doc-1', resume: 'complete' });
    await expect(unknown.run(failure.retry)).resolves.toEqual({ documentId: 'doc-1' });
    expect(unknown.api.put).toHaveBeenCalledTimes(2);

    const headings = setup({ complete: vi.fn(async () => { throw definite('LIBRARY_HEADINGS'); }) });
    const rejected = await fail(headings.run());
    expect((rejected.cause as Error).message).toBe('LIBRARY_HEADINGS');
    expect(headings.api.abandon).toHaveBeenCalledWith({ documentId: 'doc-1' });
  });
  it('treats a repeated begin that is already ready as done', async () => {
    const { api, run } = setup({ begin: vi.fn(async () => ({ documentId: 'doc-1', status: 'ready', upload: null })) });
    await expect(run()).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('prepareWord', () => {
  it('encodes UTF-8 text and keeps headings the server can store', async () => {
    const result = prepareWord({ text: '一\n二', headings: [
      { offset: 0, level: 1, text: '一' }, { offset: 2, level: 2, text: '长'.repeat(200) },
    ] });
    if (!result.ok) throw new Error('expected ok');
    expect(new Uint8Array(await result.prepared.text.arrayBuffer())).toEqual(new TextEncoder().encode('一\n二'));
    expect(result.prepared.text.type).toBe('text/plain');
    expect(result.prepared.headings).toEqual([{ offset: 0, level: 1, text: '一' }]);
  });
  it('rejects a Word file without readable text', () => {
    expect(prepareWord({ text: ' \n\t', headings: [] })).toMatchObject({ ok: false, message: expect.stringContaining('没有可以读取的文字') });
  });
});
