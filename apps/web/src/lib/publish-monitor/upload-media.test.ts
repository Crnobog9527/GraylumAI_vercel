/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { uploadPublishMedia } from './upload-media';

const slot = { uploadUrl: 'https://storage.example/signed?token=1', mediaUrl: 'https://storage.example/public/a.jpg' };

describe('publish media upload', () => {
  it('puts the file straight to the signed URL and reports its content digest', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new File(['abc'], 'a.jpg', { type: 'image/jpeg' });
    const result = await uploadPublishMedia(file, async () => slot, fetchImpl as never);
    expect(result).toEqual({ mediaUrl: slot.mediaUrl, size: 3, mimeType: 'image/jpeg',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
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
