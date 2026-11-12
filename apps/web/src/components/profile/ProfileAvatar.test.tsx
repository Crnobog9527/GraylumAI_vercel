/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ user: { getUserProfile: { invalidate: vi.fn() } } }) } }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));
import { ProfileAvatar } from './ProfileAvatar';
import { AccountAvatar } from './AccountAvatar';

describe('profile avatar (PROFILE-AVATAR)', () => {
  it('offers to change the avatar with an image-only picker and keeps the initial as fallback', () => {
    const html = renderToStaticMarkup(<ProfileAvatar src={null} initial="A" />);
    expect(html).not.toContain('暂不支持更换头像');
    expect(html).toContain('aria-label="更换头像"');
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('>A<');
  });
  it('the profile header saves avatars only through the avatar endpoint, never the ticket attachment one', () => {
    const header = readFileSync(new URL('./PersonalInfoCard.tsx', import.meta.url), 'utf8');
    const avatar = readFileSync(new URL('./ProfileAvatar.tsx', import.meta.url), 'utf8');
    const upload = readFileSync(new URL('../../lib/profile-avatar/upload.ts', import.meta.url), 'utf8');
    expect(header + avatar + upload).not.toContain('/api/upload');
    expect(header).not.toContain('avatarUrl:');
    expect(header).toContain('<ProfileAvatar');
    expect(upload).toContain("'/api/profile/avatar'");
  });
});

describe('account avatar in the rail', () => {
  it('shows the picture when there is one, the initial otherwise', () => {
    const withPicture = renderToStaticMarkup(<AccountAvatar url="https://proj.supabase.co/a.webp" initial="灰" className="x" />);
    expect(withPicture).toContain('<img');
    expect(withPicture).toContain('src="https://proj.supabase.co/a.webp"');
    expect(withPicture).not.toContain('灰');
    for (const url of [null, undefined, '']) {
      const html = renderToStaticMarkup(<AccountAvatar url={url} initial="灰" className="x" />);
      expect(html).toBe('<span class="x">灰</span>');
    }
  });
});
