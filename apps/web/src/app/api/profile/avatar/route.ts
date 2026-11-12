/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { AVATAR_MAX_BYTES, replaceProfileAvatar, type AvatarClient } from '@repo/api/src/services/profileAvatar/storage';
import { logServerError } from '@/lib/server-log';

/** PROFILE-AVATAR (Owner 2026-11-12): the signed-in user replaces their own avatar. The profile is the token's user;
 * no id is read from the request. The browser crops and compresses first; the type is checked again from the bytes. */
export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    if (!token) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    // Refuse an oversized body before reading it (a form adds a few hundred bytes of framing).
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES + 64 * 1024) {
      return NextResponse.json({ error: '图片不能超过 2MB' }, { status: 413 });
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !anon || !service) return NextResponse.json({ error: '头像暂时无法保存，请稍后重试' }, { status: 503 });
    const { data: { user }, error } = await createClient(url, anon).auth.getUser(token);
    if (error || !user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const admin = createClient(url, service);

    const maintenance = await admin.from('system_settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
    const on = maintenance.error || maintenance.data?.value === true || maintenance.data?.value === 'true';
    if (on) return NextResponse.json({ error: '系统维护中，暂时无法修改头像' }, { status: 503 });

    const file = (await request.formData()).get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: '请选择一张图片' }, { status: 400 });
    if (file.size > AVATAR_MAX_BYTES) return NextResponse.json({ error: '图片不能超过 2MB' }, { status: 413 });
    const result = await replaceProfileAvatar({ client: admin as unknown as AvatarClient, supabaseUrl: url, profileId: user.id,
      bytes: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json(result.status === 200 ? { avatarUrl: result.avatarUrl } : { error: result.error }, { status: result.status });
  } catch {
    logServerError('api', 'profile_avatar_upload_failed');
    return NextResponse.json({ error: '头像暂时无法保存，请稍后重试' }, { status: 500 });
  }
}
