/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createTRPCContext } from '@repo/api/src/trpc';
import { readFounderWallPublic } from '@repo/api/src/services/founder/member';
import { FoundersWall, type WallEntry } from '@/components/founder/FoundersWall';
import { getPublicSiteSettings } from '@/lib/public-site';
import { buildPageMetadata } from '@/lib/seo/metadata';

// Read on every request: a withdrawn or ended card must leave the wall at once, not after a cache refresh.
export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return buildPageMetadata({
    title: '创始会员墙', path: '/founders', description: 'Graylum 创始会员中，愿意公开展示自己账号和作品的会员。',
  });
}

/** A failed read shows the same "opening soon" state as an empty wall; it never guesses entries. */
async function readEntries(): Promise<WallEntry[]> {
  try {
    const ctx = await createTRPCContext({ headers: new Headers() });
    if (!ctx.hasSupabaseAdminPrivileges || !ctx.supabaseAdmin) return [];
    return await readFounderWallPublic(ctx.supabaseAdmin);
  } catch {
    return [];
  }
}

export default async function Page() {
  const [entries, { supportEmail }] = await Promise.all([readEntries(), getPublicSiteSettings()]);
  return <FoundersWall entries={entries} supportEmail={supportEmail} />;
}
