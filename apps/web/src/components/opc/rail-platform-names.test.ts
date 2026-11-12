/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { platformName } from '@/components/publish-monitor/labels';

// Validation 2026-11-12: the rail's "平台 · 账号 · 工作" groups were titled with the stored platform codes (xiaohongshu, douyin).
it('the rail titles a platform group with the platform\'s name, not its stored code', () => {
  const frame = readFileSync(fileURLToPath(new URL('./workspace-frame.tsx', import.meta.url)), 'utf8');
  expect(frame).toContain('<RailGroup key={platform} title={platformName(platform)}');
  expect(frame).not.toContain('title={platform}');
  // The group is still keyed and remembered by the code, so an open or folded group stays as the user left it.
  expect(frame).toContain("groupOpen['platform:'+platform]");
});

it('names the platforms a brand account can be on, and leaves a name it does not know as it is', () => {
  expect(platformName('xiaohongshu')).toBe('小红书');
  expect(platformName('douyin')).toBe('抖音');
  expect(platformName('tiktok')).toBe('TikTok');
  expect(platformName('小红书')).toBe('小红书');
  expect(platformName('某个新平台')).toBe('某个新平台');
});
