/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileAvatar } from './ProfileAvatar';

describe('profile avatar', () => {
  it('shows the avatar with a disabled change control and no file input', () => {
    const html = renderToStaticMarkup(<ProfileAvatar src={null} initial="A" />);
    expect(html).toContain('暂不支持更换头像');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain('type="file"');
    expect(html).toContain('>A<');
  });
  it('the profile header never uploads an avatar through the ticket attachment endpoint', () => {
    const source = readFileSync(new URL('./PersonalInfoCard.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('/api/upload');
    expect(source).not.toContain('avatarUrl');
    expect(source).toContain('<ProfileAvatar');
  });
});
