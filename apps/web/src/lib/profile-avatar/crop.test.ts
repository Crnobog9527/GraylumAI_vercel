/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));
import { avatarInputProblem, centredSquare } from './crop';
import { uploadAvatar } from './upload';

const file = (type: string, size = 10) => new File([new Uint8Array(size)], 'x', { type });

describe('avatar input check', () => {
  it('only JPG, PNG and WebP, up to 20 MB before compression', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) expect(avatarInputProblem(file(type))).toBeNull();
    for (const type of ['image/gif', 'image/svg+xml', 'image/heic', 'application/pdf', '']) {
      expect(avatarInputProblem(file(type))).toBe('只支持 JPG、PNG 或 WebP 图片');
    }
    expect(avatarInputProblem({ type: 'image/png', size: 20 * 1024 * 1024 + 1 })).toBe('图片太大了，请换一张 20MB 以内的图片');
    expect(avatarInputProblem({ type: 'image/png', size: 0 })).not.toBeNull();
  });
  it('crops the centred square', () => {
    expect(centredSquare(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(centredSquare(300, 401)).toEqual({ sx: 0, sy: 50, side: 300 });
    expect(centredSquare(64, 64)).toEqual({ sx: 0, sy: 0, side: 64 });
  });
});

describe('uploadAvatar', () => {
  const cropped = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('sends the cropped image, not the original, with the user\'s token', async () => {
    const post = reply(200, { avatarUrl: 'https://proj.supabase.co/a.webp' });
    const crop = vi.fn(async () => cropped);
    const result = await uploadAvatar(file('image/png', 5000), { crop, token: async () => 'tkn', post: post as never });
    expect(result).toEqual({ ok: true, avatarUrl: 'https://proj.supabase.co/a.webp' });
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/profile/avatar');
    expect(init.headers).toEqual({ Authorization: 'Bearer tkn' });
    const sent = (init.body as FormData).get('file') as File;
    expect([sent.size, sent.type, sent.name]).toEqual([3, 'image/webp', 'avatar.webp']);
  });

  it('a wrong type never reaches the network; the server\'s refusal is shown as is', async () => {
    const post = reply(200, {});
    expect(await uploadAvatar(file('image/gif'), { crop: async () => cropped, token: async () => 't', post: post as never }))
      .toEqual({ ok: false, message: '只支持 JPG、PNG 或 WebP 图片' });
    expect(post).not.toHaveBeenCalled();
    const refused = reply(413, { error: '图片不能超过 2MB' });
    expect(await uploadAvatar(file('image/png'), { crop: async () => cropped, token: async () => 't', post: refused as never }))
      .toEqual({ ok: false, message: '图片不能超过 2MB' });
    const limited = reply(429, { error: 'Too Many Requests' });
    expect((await uploadAvatar(file('image/png'), { crop: async () => cropped, token: async () => 't', post: limited as never })))
      .toEqual({ ok: false, message: '操作太频繁了，请稍等一分钟再试' });
  });

  it('an unreadable image, no session or a network failure is a plain message', async () => {
    expect((await uploadAvatar(file('image/png'), { crop: async () => { throw new Error('decode'); } })).ok).toBe(false);
    expect(await uploadAvatar(file('image/png'), { crop: async () => cropped, token: async () => null }))
      .toEqual({ ok: false, message: '登录已过期，请重新登录后再试' });
    const down = vi.fn(async () => { throw new Error('offline'); });
    expect(await uploadAvatar(file('image/png'), { crop: async () => cropped, token: async () => 't', post: down as never }))
      .toEqual({ ok: false, message: '头像上传失败，请稍后重试' });
  });
});
