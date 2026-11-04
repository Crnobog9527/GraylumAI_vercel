/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The one Chinese display name of each platform in a review pack. The model writes only these names (the Skill says so), so
 * TikTok is never called Douyin: they are two platforms. Kept equal to the data review page's names (apps/web labels.ts).
 */
export const PLATFORM_NAMES: Record<string, string> = {
  x: 'X', youtube: 'YouTube', tiktok: 'TikTok', tiktok_business: 'TikTok 商业号', instagram: 'Instagram',
  facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn', pinterest: 'Pinterest', bluesky: 'Bluesky',
  xiaohongshu: '小红书', douyin: '抖音',
};
export const platformName = (code: string) => PLATFORM_NAMES[code] ?? code;

/** Code -> display name of every platform the rows mention, in code order. */
export function packPlatforms(codes: Iterable<string>): Record<string, string> {
  return Object.fromEntries([...new Set(codes)].sort().map(code => [code, platformName(code)]));
}

/**
 * Platforms whose name the prose uses although the pack has no such platform (a Douyin review of TikTok data). "X" is too short to
 * search for, and "TikTok 商业号" counts as TikTok for the plain name.
 */
export function foreignPlatforms(body: string, have: Record<string, string>): string[] {
  const text = body.toLowerCase();
  return Object.entries(PLATFORM_NAMES).filter(([code, name]) => {
    if (name.length < 2 || code === 'tiktok_business' || code in have) return false;
    if (code === 'tiktok' && 'tiktok_business' in have) return false;
    return text.includes(name.toLowerCase());
  }).map(([code]) => code);
}
