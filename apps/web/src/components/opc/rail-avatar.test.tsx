/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RailBottom } from './rail-view';

const bottom = (avatarUrl?: string | null) => renderToStaticMarkup(<RailBottom creditsLabel={500} creditsOpen={false} profileOpen={false}
  avatar="灰" avatarUrl={avatarUrl} name="灰度" membership="免费版"/>);

describe('PROFILE-AVATAR: the account\'s picture in the rail and the top bar', () => {
  it('the rail button shows the uploaded avatar, and the initial circle without one', () => {
    const shown = bottom('https://proj.supabase.co/storage/v1/object/public/profile-avatars/a/b.webp');
    expect(shown).toContain('src="https://proj.supabase.co/storage/v1/object/public/profile-avatars/a/b.webp"');
    expect(shown).toContain('referrerPolicy="no-referrer"');
    for (const none of [null, undefined, '']) {
      const html = bottom(none);
      // The rail's own icons are images too; the avatar's picture is the one sent without a referrer.
      expect(html).not.toContain('referrerPolicy="no-referrer"');
      expect(html).toContain('>灰<');
    }
  });

  it('the account popover and the home page top bar use the same avatar', () => {
    const frame = readFileSync(new URL('./workspace-frame.tsx', import.meta.url), 'utf8');
    expect(frame).toContain('avatarUrl={profile.data?.avatar_url}');
    expect(frame).toMatch(/<AccountAvatar className=\{styles\.avatar\} url=\{profile\.data\?\.avatar_url\}/);
    const home = readFileSync(new URL('../../app/(zh-hans)/app/page.tsx', import.meta.url), 'utf8');
    expect(home).toMatch(/<AccountAvatar url=\{profile\.data\?\.avatar_url\}/);
  });
});
