/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { swallow } from '../../lib/swallow';
import { CHAT_PHOTO_BUCKET, CHAT_PHOTO_MAX_BYTES, isChatPhotoPath, isJpeg } from './photos';

/*
 * INTEGRATION-SHOTVIVA: how Shotviva reads one chat photo to make an image from it (Owner 2026-11-13: "照片只有本人能看；交给
 * Shotviva 出图时只给几分钟有效的临时地址"). Shotviva fetches an https address whose host is on its exact allowlist (Graylum's own
 * hosts), refuses redirects and takes one image. So the address is a Graylum route carrying a signed Storage token valid for
 * PHOTO_GRANT_SECONDS: Storage itself checks the token's signature, path and expiry. No new secret.
 */
export const PHOTO_GRANT_SECONDS = 300;
export const PHOTO_SHARED_ROUTE = '/api/chat-photos/shared';
/** A signed Storage token is a JWT: three base64url parts. */
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type Result<T> = { data: T; error: unknown };
export type GrantClient = { storage: { from(bucket: string): {
  createSignedUrl(path: string, expiresIn: number): PromiseLike<Result<{ signedUrl: string } | null>>;
} } };

/** The address Shotviva fetches one of this conversation's photos from: this Graylum origin (https only) and a signed token valid
 * for PHOTO_GRANT_SECONDS. null when the photo is not this account's and conversation's, or Storage cannot sign it. */
export async function photoGrantUrl(input: { client: GrantClient; appOrigin: string; profileId: string; sessionId: string;
  path: string }): Promise<string | null> {
  if (!isChatPhotoPath(input.path, input.profileId, input.sessionId)) return null;
  let origin: URL;
  try { origin = new URL(input.appOrigin); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search) return null;
  let signed: Result<{ signedUrl: string } | null> | null;
  try {
    signed = await swallow('chat_photo_sign_failed',
      input.client.storage.from(CHAT_PHOTO_BUCKET).createSignedUrl(input.path, PHOTO_GRANT_SECONDS), null);
  } catch { return null; }
  if (!signed || signed.error || !signed.data?.signedUrl) return null;
  let token: string | null;
  try { token = new URL(signed.data.signedUrl).searchParams.get('token'); } catch { token = null; }
  if (!token || !TOKEN.test(token)) return null;
  const url = new URL(PHOTO_SHARED_ROUTE, origin);
  url.searchParams.set('p', input.path);
  url.searchParams.set('t', token);
  return url.toString();
}

/** The route behind photoGrantUrl: passes the token to Storage, which checks its signature, its path and its expiry. Only this
 * bucket and names the service writes; no redirects; a JPEG within the cap; 404 for anything Storage refuses. */
export async function fetchGrantedPhoto(input: { supabaseUrl: string; path: string | null; token: string | null;
  fetch?: typeof fetch }): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 404 | 502 }> {
  if (!input.path || !input.token || !isChatPhotoPath(input.path) || !TOKEN.test(input.token)) return { ok: false, status: 404 };
  const url = new URL(`/storage/v1/object/sign/${CHAT_PHOTO_BUCKET}/${input.path}`, new URL(input.supabaseUrl).origin);
  url.searchParams.set('token', input.token);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  } catch { return { ok: false, status: 502 }; }
  if (!response.ok || !response.body) {
    if (response.body) await swallow('chat_photo_body_cancel_failed', response.body.cancel(), undefined);
    return { ok: false, status: 404 };
  }
  if (Number(response.headers.get('content-length')) > CHAT_PHOTO_MAX_BYTES) {
    await swallow('chat_photo_body_cancel_failed', response.body.cancel(), undefined);
    return { ok: false, status: 502 };
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > CHAT_PHOTO_MAX_BYTES) { await reader.cancel(); return { ok: false, status: 502 }; }
      parts.push(next.value);
    }
  } catch { return { ok: false, status: 502 }; }
  const bytes = Buffer.concat(parts);
  return isJpeg(bytes) ? { ok: true, bytes } : { ok: false, status: 502 };
}
