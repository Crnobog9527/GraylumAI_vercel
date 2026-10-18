/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/public-site/SiteShell', () => ({ SiteShell: ({ children }: { children: unknown }) => createElement('div', null, children as never) }));

import { FoundersWall, MIN_WALL_ENTRIES, type WallEntry } from './FoundersWall';

const entry = (index: number): WallEntry => ({
  displayName: `会员${index}`, intro: '做小红书', productName: '产品', productUrl: `https://p${index}.example.test/`,
  socialAccounts: [{ platform: 'xiaohongshu', handle: `acc${index}`, url: `https://xhs.example.test/${index}` }],
});

describe('FoundersWall', () => {
  it('stays closed below the threshold and lists nobody', () => {
    const html = renderToStaticMarkup(createElement(FoundersWall, { entries: [entry(1)] }));
    expect(html).toContain('即将开放');
    expect(html).not.toContain('会员1');
  });
  it('lists cards with nofollow ugc external links once open', () => {
    const entries = Array.from({ length: MIN_WALL_ENTRIES }, (_, i) => entry(i));
    const html = renderToStaticMarkup(createElement(FoundersWall, { entries }));
    expect(html.match(/founders-wall-card/g)).toHaveLength(MIN_WALL_ENTRIES);
    expect(html).toContain('rel="nofollow ugc noopener noreferrer"');
    expect(html).toContain('小红书');
    expect(html.match(/data-testid="founder-badge"/g)).toHaveLength(MIN_WALL_ENTRIES);
    expect(html).not.toContain('<main');
    expect(html).not.toContain('即将开放');
  });
});
