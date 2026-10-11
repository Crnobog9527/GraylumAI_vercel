/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { runLibraryUpload, settleFailedAttempt, UploadFailure, type UploadApi, type UploadAttempt } from './upload-flow';

const file = new Blob(['hello']);
function setup(overrides: Partial<UploadApi> = {}) {
  const api: UploadApi = {
    begin: vi.fn(async () => ({ documentId: 'doc-1', status: 'uploading', upload: { signedUrl: 'https://s/x?token=t' } })),
    complete: vi.fn(async () => ({ status: 'ready' })),
    abandon: vi.fn(async () => ({ status: 'deleting' })),
    put: vi.fn(async (_url, _file, _type, progress) => { progress(0.5); progress(1); }),
    ...overrides,
  };
  let n = 0;
  const stages: string[] = [];
  const run = (attempt: UploadAttempt = { requestId: 'req-0', resume: 'begin' }) => runLibraryUpload(api, {
    file, filename: 'a.txt', contentType: 'text/plain', purpose: 'authored', attempt,
    newId: () => 'req-' + ++n, onStage: (stage) => stages.push(stage),
  });
  return { api, run, stages };
}
const fail = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as UploadFailure; }
  throw new Error('expected failure');
};
const definite = (code: string) => Object.assign(new Error(code), { data: { code: 'BAD_REQUEST' } });

describe('runLibraryUpload', () => {
  it('begins, transfers with progress, and completes', async () => {
    const { api, run, stages } = setup();
    await expect(run()).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-0', bytes: 5, purpose: 'authored' }));
    expect(api.complete).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(stages).toEqual(['begin', 'transfer', 'transfer', 'transfer', 'complete']);
  });
  it('keeps the same requestId after an unknown begin result, but not after a definite rejection', async () => {
    const network = setup({ begin: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    expect((await fail(network.run())).retry).toEqual({ requestId: 'req-0', resume: 'begin' });
    const space = setup({ begin: vi.fn(async () => { throw definite('LIBRARY_SPACE'); }) });
    const failure = await fail(space.run());
    expect(failure.retry).toEqual({ requestId: 'req-1', resume: 'begin' });
    expect((failure.cause as Error).message).toBe('LIBRARY_SPACE');
  });
  it('treats a repeated begin that is already ready as done', async () => {
    const { api, run } = setup({ begin: vi.fn(async () => ({ documentId: 'doc-1', status: 'ready', upload: null })) });
    await expect(run()).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.put).not.toHaveBeenCalled();
  });
  it('releases a row whose link cannot be re-sent, then starts a new request', async () => {
    const begin = vi.fn()
      .mockResolvedValueOnce({ documentId: 'old', status: 'uploading', upload: null })
      .mockResolvedValueOnce({ documentId: 'doc-2', status: 'uploading', upload: { signedUrl: 'u' } });
    const { api, run } = setup({ begin });
    await expect(run()).resolves.toEqual({ documentId: 'doc-2' });
    expect(api.abandon).toHaveBeenCalledWith({ documentId: 'old' });
    expect(begin.mock.calls[1][0].requestId).toBe('req-1');
  });
  it('abandons after a failed transfer and retries with a new request', async () => {
    const { api, run } = setup({ put: vi.fn(async () => { throw new Error('UPLOAD_NETWORK'); }) });
    const failure = await fail(run());
    expect(api.abandon).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(api.complete).not.toHaveBeenCalled();
    expect(failure.retry).toEqual({ requestId: 'req-1', resume: 'begin' });
  });
  it('restarts after a definite complete rejection (server already removed it)', async () => {
    const { run } = setup({ complete: vi.fn(async () => { throw definite('LIBRARY_TYPE'); }) });
    expect((await fail(run())).retry).toEqual({ requestId: 'req-1', resume: 'begin' });
  });
  it('re-checks the same document after an unknown complete result', async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce({ status: 'ready' });
    const { api, run } = setup({ complete });
    const failure = await fail(run());
    expect(failure.retry).toEqual({ requestId: 'req-0', documentId: 'doc-1', resume: 'complete' });
    await expect(run(failure.retry)).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledTimes(1);
  });
  it('starts over when the re-checked document no longer exists', async () => {
    const complete = vi.fn().mockRejectedValueOnce(definite('LIBRARY_NOT_FOUND')).mockResolvedValue({ status: 'ready' });
    const { api, run } = setup({ complete });
    await expect(run({ requestId: 'req-0', documentId: 'gone', resume: 'complete' })).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1' }));
  });
  it('does not start a replacement until an unconfirmed release succeeds', async () => {
    const abandon = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue({ status: 'deleting' });
    const { api, run } = setup({ abandon, put: vi.fn(async () => { throw new Error('UPLOAD_NETWORK'); }) });
    const first = await fail(run());
    expect(first.retry).toEqual({ requestId: 'req-1', resume: 'begin', releaseFirst: 'doc-1' });
    const second = await fail(run(first.retry));
    expect(second.retry).toEqual(first.retry);
    expect(api.begin).toHaveBeenCalledTimes(1);
    await fail(run(first.retry));
    expect(abandon).toHaveBeenLastCalledWith({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'req-1' }));
  });
  it('keeps the unreleased row when a link cannot be re-sent and its release fails', async () => {
    const { api, run } = setup({
      begin: vi.fn(async () => ({ documentId: 'old', status: 'uploading', upload: null })),
      abandon: vi.fn(async () => { throw new Error('Failed to fetch'); }),
    });
    expect((await fail(run())).retry).toEqual({ requestId: 'req-1', resume: 'begin', releaseFirst: 'old' });
    expect(api.begin).toHaveBeenCalledTimes(1);
  });
});

describe('settleFailedAttempt (removing a failed upload keeps its recovery work)', () => {
  const abandonOk = () => vi.fn(async () => ({ status: 'deleted' }));
  it('does the release a retry still owed before the item can go', async () => {
    const abandon = abandonOk();
    const recheck = vi.fn();
    await settleFailedAttempt({ abandon }, { requestId: 'r', resume: 'begin', releaseFirst: 'old' }, recheck);
    expect(abandon).toHaveBeenCalledWith({ documentId: 'old' });
    expect(recheck).not.toHaveBeenCalled();
  });
  it('keeps the item (throws) when that release is not confirmed', async () => {
    const abandon = vi.fn(async () => { throw new Error('Failed to fetch'); });
    await expect(settleFailedAttempt({ abandon }, { requestId: 'r', resume: 'begin', releaseFirst: 'old' }, vi.fn()))
      .rejects.toThrow('Failed to fetch');
  });
  it('re-checks an unknown completion instead of releasing a row that may be ready', async () => {
    const abandon = abandonOk();
    const recheck = vi.fn(async () => ({ status: 'ready' }));
    await settleFailedAttempt({ abandon }, { requestId: 'r', documentId: 'd', resume: 'complete' }, recheck);
    expect(recheck).toHaveBeenCalledWith('d');
    expect(abandon).not.toHaveBeenCalled();
  });
  it('releases after a definite re-check rejection, and keeps the item while still unknown', async () => {
    const abandon = abandonOk();
    await settleFailedAttempt({ abandon }, { requestId: 'r', documentId: 'd', resume: 'complete' },
      vi.fn(async () => { throw definite('LIBRARY_TYPE'); }));
    expect(abandon).toHaveBeenCalledWith({ documentId: 'd' });
    await expect(settleFailedAttempt({ abandon }, { requestId: 'r', documentId: 'd', resume: 'complete' },
      vi.fn(async () => { throw new Error('Failed to fetch'); }))).rejects.toThrow('Failed to fetch');
  });
  it('releases a Word row still waiting for its text', async () => {
    const abandon = abandonOk();
    await settleFailedAttempt({ abandon }, { requestId: 'r', documentId: 'w', resume: 'text' }, vi.fn());
    expect(abandon).toHaveBeenCalledWith({ documentId: 'w' });
  });
  it('has nothing to settle for a plain begin failure', async () => {
    const abandon = abandonOk();
    await settleFailedAttempt({ abandon }, { requestId: 'r', resume: 'begin' }, vi.fn());
    await settleFailedAttempt({ abandon }, undefined, vi.fn());
    expect(abandon).not.toHaveBeenCalled();
  });
});
