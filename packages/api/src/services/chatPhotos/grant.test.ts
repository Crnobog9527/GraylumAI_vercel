/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { PHOTO_GRANT_SECONDS, fetchGrantedPhoto, photoGrantUrl, type GrantClient } from './grant';
import { CHAT_PHOTO_BUCKET, CHAT_PHOTO_MAX_BYTES } from './photos';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const SESSION_2 = '00000000-0000-4000-8000-0000000000a2';
const PHOTO = `${ME}/${SESSION}.7.0.00000000-0000-4000-8000-000000000071.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
// A token shaped like Storage's (three base64url parts), made at run time so no JWT-looking text sits in the repository (secret scan).
const part = (text: string) => Buffer.from(text).toString('base64url');
const TOKEN = [part('{"alg":"HS256"}'), part('{"url":"chat-photos/x"}'), part('signature')].join('.');

function signer(result: unknown = undefined) {
  const createSignedUrl = vi.fn(async (path: string) => result ?? ({ error: null,
    data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${CHAT_PHOTO_BUCKET}/${path}?token=${TOKEN}` } }));
  const from = vi.fn(() => ({ createSignedUrl }));
  return { client: { storage: { from } } as unknown as GrantClient, createSignedUrl, from };
}

describe('photoGrantUrl: the only way Shotviva reads a photo', () => {
  it('a Graylum https address with a signed token valid a few minutes, for this conversation\'s photo', async () => {
    const s = signer();
    const url = await photoGrantUrl({ client: s.client, appOrigin: 'https://auth-staging.graylum.com', profileId: ME, sessionId: SESSION,
      path: PHOTO });
    expect(s.from).toHaveBeenCalledWith(CHAT_PHOTO_BUCKET);
    expect(s.createSignedUrl).toHaveBeenCalledWith(PHOTO, PHOTO_GRANT_SECONDS);
    expect(PHOTO_GRANT_SECONDS).toBeLessThanOrEqual(600);
    const parsed = new URL(url!);
    expect(parsed.origin).toBe('https://auth-staging.graylum.com');
    expect(parsed.pathname).toBe('/api/chat-photos/shared');
    expect(parsed.searchParams.get('p')).toBe(PHOTO);
    expect(parsed.searchParams.get('t')).toBe(TOKEN);
    expect(url).not.toContain('supabase.co');
  });

  it('another account\'s or conversation\'s photo, plain http, credentials or a path on the origin: no address, nothing signed', async () => {
    const s = signer();
    const grant = (over: object) => photoGrantUrl({ client: s.client, appOrigin: 'https://www.graylum.com', profileId: ME,
      sessionId: SESSION, path: PHOTO, ...over });
    expect(await grant({ profileId: OTHER })).toBeNull();
    expect(await grant({ sessionId: SESSION_2 })).toBeNull();
    for (const appOrigin of ['http://www.graylum.com', 'https://u:p@www.graylum.com', 'https://www.graylum.com/evil', 'not a url'])
      expect(await grant({ appOrigin }), appOrigin).toBeNull();
    expect(s.createSignedUrl).not.toHaveBeenCalled();
    const refused = signer({ data: null, error: new Error('no') });
    expect(await photoGrantUrl({ client: refused.client, appOrigin: 'https://www.graylum.com', profileId: ME, sessionId: SESSION,
      path: PHOTO })).toBeNull();
  });
});

describe('fetchGrantedPhoto (the route behind the address)', () => {
  const jpeg = (headers: Record<string, string> = {}, body: Uint8Array = JPEG) =>
    vi.fn(async () => new Response(body as BodyInit, { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } }));
  const get = (send: ReturnType<typeof vi.fn>, over: object = {}) => fetchGrantedPhoto({ supabaseUrl: 'https://proj.supabase.co',
    path: PHOTO, token: TOKEN, fetch: send as never, ...over });

  it('asks Storage with the token, no redirects, and passes the JPEG on', async () => {
    const send = jpeg();
    expect(await get(send)).toEqual({ ok: true, bytes: Buffer.from(JPEG) });
    const [url, init] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://proj.supabase.co/storage/v1/object/sign/${CHAT_PHOTO_BUCKET}/${PHOTO}?token=${TOKEN}`);
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });

  it('no token, a bad token, another bucket\'s name or a strange path: Storage is not asked', async () => {
    for (const over of [{ token: null }, { token: 'not-a-jwt' }, { path: null }, { path: '../profile-avatars/x.jpg' },
      { path: PHOTO.replace('.jpg', '.png') }, { path: `${PHOTO}?x=1` }]) {
      const send = jpeg();
      expect(await get(send, over), JSON.stringify(over)).toEqual({ ok: false, status: 404 });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('an expired or forged token (Storage refuses), not a JPEG, too large, or unreachable: no photo', async () => {
    expect(await get(vi.fn(async () => new Response('{"error":"expired"}', { status: 400 })))).toEqual({ ok: false, status: 404 });
    expect(await get(jpeg({}, new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c])))).toEqual({ ok: false, status: 502 });
    expect(await get(jpeg({ 'content-length': String(CHAT_PHOTO_MAX_BYTES + 1) }))).toEqual({ ok: false, status: 502 });
    expect(await get(jpeg({}, new Uint8Array(CHAT_PHOTO_MAX_BYTES + 1).fill(0xff)))).toEqual({ ok: false, status: 502 });
    expect(await get(vi.fn(async () => { throw new TypeError('redirect'); }))).toEqual({ ok: false, status: 502 });
  });
});
