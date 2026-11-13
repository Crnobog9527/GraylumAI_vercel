/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@/lib/supabase';
import { avatarInputProblem, cropAvatar } from './crop';

export type AvatarUploadResult = { ok: true; avatarUrl: string } | { ok: false; message: string };
const FAILED = '头像上传失败，请稍后重试';

/** Check, crop and compress in the browser, then send to /api/profile/avatar as the signed-in user. */
export async function uploadAvatar(file: File, deps: {
  crop?: (file: Blob) => Promise<Blob>; token?: () => Promise<string | null>; post?: typeof fetch;
} = {}): Promise<AvatarUploadResult> {
  const problem = avatarInputProblem(file);
  if (problem) return { ok: false, message: problem };
  let image: Blob;
  try { image = await (deps.crop ?? cropAvatar)(file); }
  catch { return { ok: false, message: '这张图片无法读取，请换一张 JPG、PNG 或 WebP 图片' }; }
  const token = await (deps.token ?? (async () => (await createClient().auth.getSession()).data.session?.access_token ?? null))()
    .catch(() => null);
  if (!token) return { ok: false, message: '登录已过期，请重新登录后再试' };
  const form = new FormData();
  form.append('file', image, image.type === 'image/webp' ? 'avatar.webp' : 'avatar.jpg');
  try {
    const response = await (deps.post ?? fetch)('/api/profile/avatar', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const body = await response.json().catch(() => null) as { avatarUrl?: unknown; error?: unknown } | null;
    if (response.ok && typeof body?.avatarUrl === 'string') return { ok: true, avatarUrl: body.avatarUrl };
    if (response.status === 429) return { ok: false, message: '操作太频繁了，请稍等一分钟再试' };
    return { ok: false, message: typeof body?.error === 'string' && body.error ? body.error : FAILED };
  } catch { return { ok: false, message: FAILED }; }
}
