/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ context: vi.fn(), fetchImage: vi.fn() }));
vi.mock('@/lib/shotviva-connect', () => ({ shotvivaRouteContext: mocks.context }));
vi.mock('@repo/api/src/services/connectors/shotviva/images', () => ({ fetchJobImage: mocks.fetchImage }));
import { GET } from './route';

const me = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-0000000000bb';
const get = (job: string) => GET(new NextRequest(`https://www.graylum.com/api/connectors/shotviva/image?job=${job}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ admin: {}, profileId: me, baseUrl: 'https://shotviva.test' });
  mocks.fetchImage.mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/webp' });
});

describe('GET /api/connectors/shotviva/image', () => {
  it('the signed-in user\'s own image, private and not sniffed', async () => {
    const response = await get(JOB);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.fetchImage).toHaveBeenCalledWith({ admin: {}, baseUrl: 'https://shotviva.test', profileId: me, jobId: JOB });
  });

  it('a bad id, a signed-out visitor, someone else\'s or an unfinished job: no image', async () => {
    expect((await get('../x')).status).toBe(400);
    mocks.context.mockResolvedValueOnce({ admin: {}, profileId: null, baseUrl: 'x' });
    expect((await get(JOB)).status).toBe(401);
    mocks.fetchImage.mockResolvedValueOnce({ ok: false, status: 404 });
    expect((await get(JOB)).status).toBe(404);
    mocks.fetchImage.mockRejectedValueOnce(new Error('private'));
    expect((await get(JOB)).status).toBe(502);
  });
});
