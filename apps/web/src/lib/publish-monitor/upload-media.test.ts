/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { mediaDigest, uploadPublishMedia } from './upload-media';

const slot = { uploadUrl: 'https://storage.example/signed?token=1', mediaUrl: 'https://storage.example/public/a.jpg' };

describe('publish media upload', () => {
  it('puts the file straight to the signed URL and reports its content digest', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new File(['abc'], 'a.jpg', { type: 'image/jpeg' });
    const result = await uploadPublishMedia(file, async () => slot, fetchImpl as never);
    expect(result).toEqual({ mediaUrl: slot.mediaUrl, size: 3, mimeType: 'image/jpeg',
      sha256: await mediaDigest(file) });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchImpl).toHaveBeenCalledWith(slot.uploadUrl, expect.objectContaining({ method: 'PUT', body: file,
      credentials: 'omit', headers: { 'Content-Type': 'image/jpeg' } }));
  });

  it('asks for no upload slot for an unsupported file and fails closed on a failed upload', async () => {
    const requestSlot = vi.fn(async () => slot);
    await expect(uploadPublishMedia(new File(['x'], 'a.txt', { type: 'text/plain' }), requestSlot))
      .rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' });
    expect(requestSlot).not.toHaveBeenCalled();
    const failing = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(uploadPublishMedia(new File(['x'], 'a.png', { type: 'image/png' }), requestSlot, failing as never))
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
    const requestSlot = vi.fn(async () => slot);
    await expect(uploadPublishMedia(new File([], 'a.png', { type: 'image/png' }), requestSlot))
      .rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    const huge = new File(['x'], 'v.mp4', { type: 'video/mp4' });
    Object.defineProperty(huge, 'size', { value: 6 * 1024 ** 3 });
    await expect(uploadPublishMedia(huge, requestSlot)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(requestSlot).not.toHaveBeenCalled();
  });
});
