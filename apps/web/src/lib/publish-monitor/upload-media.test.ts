/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { mediaDigest, uploadPublishFiles } from './upload-media';

const slot = { uploadUrl: 'https://storage.example/signed?token=1', mediaUrl: 'https://storage.example/public/a.jpg' };

describe('publish media upload', () => {
  it('requests every slot of the post at once and puts each file straight to its signed URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const files = [new File(['abc'], 'a.jpg', { type: 'image/jpeg' }), new File(['de'], 'b.png', { type: 'image/png' })];
    const second = { uploadUrl: 'https://storage.example/signed?token=2', mediaUrl: 'https://storage.example/public/b.png' };
    const requestSlots = vi.fn(async (count: number) => [slot, second].slice(0, count));
    const result = await uploadPublishFiles(files, requestSlots, fetchImpl as never);
    expect(requestSlots).toHaveBeenCalledTimes(1);
    expect(requestSlots).toHaveBeenCalledWith(2);
    expect(result).toEqual([
      { mediaUrl: slot.mediaUrl, size: 3, mimeType: 'image/jpeg', sha256: await mediaDigest(files[0]!) },
      { mediaUrl: second.mediaUrl, size: 2, mimeType: 'image/png', sha256: await mediaDigest(files[1]!) }]);
    expect(fetchImpl).toHaveBeenCalledWith(slot.uploadUrl, expect.objectContaining({ method: 'PUT', body: files[0],
      credentials: 'omit', headers: { 'Content-Type': 'image/jpeg' } }));
  });

  it('asks for no upload slot when any file is unsupported, and fails closed on a failed upload', async () => {
    const requestSlots = vi.fn(async () => [slot]);
    await expect(uploadPublishFiles([new File(['x'], 'a.txt', { type: 'text/plain' })], requestSlots))
      .rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' });
    await expect(uploadPublishFiles(Array.from({ length: 11 }, () => new File(['x'], 'a.png', { type: 'image/png' })),
      requestSlots)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(requestSlots).not.toHaveBeenCalled();
    const failing = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(uploadPublishFiles([new File(['x'], 'a.png', { type: 'image/png' })], requestSlots, failing as never))
      .rejects.toMatchObject({ code: 'MEDIA_UPLOAD_FAILED' });
  });
});

describe('media digest', () => {
  it('reads only the head and tail of a large file, and still tells different files apart', async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const changedMiddle = big.slice();
    changedMiddle[4.5 * 1024 * 1024] = 1;
    const changedEnd = big.slice();
    changedEnd[big.length - 1] = 1;
    const base = await mediaDigest(new Blob([big]));
    const file = new Blob([big]);
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    await mediaDigest(file);
    expect(read.mock.contexts.every(ctx => (ctx as Blob).size <= 8 * 1024 * 1024 + 32)).toBe(true);
    read.mockRestore();
    expect(await mediaDigest(new Blob([changedEnd]))).not.toBe(base);
    expect(await mediaDigest(new Blob([big.slice(1)]))).not.toBe(base);
    // A change only in the middle of a large file is the same fingerprint: identity only, not integrity.
    expect(await mediaDigest(new Blob([changedMiddle]))).toBe(base);
  });

  it('refuses empty and oversized files before asking for an upload slot', async () => {
    const requestSlots = vi.fn(async () => [slot]);
    await expect(uploadPublishFiles([new File([], 'a.png', { type: 'image/png' })], requestSlots))
      .rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    const huge = new File(['x'], 'v.mp4', { type: 'video/mp4' });
    Object.defineProperty(huge, 'size', { value: 6 * 1024 ** 3 });
    await expect(uploadPublishFiles([huge], requestSlots)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(requestSlots).not.toHaveBeenCalled();
  });
});
