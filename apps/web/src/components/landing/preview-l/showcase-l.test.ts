/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { L_CARE } from '@/lib/landing/landing-copy-l';
import { L_SHOWCASE, L_SHOWCASE_LIBRARY, L_SHOWCASE_VOICE } from '@/lib/landing/landing-copy-l-showcase';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { ShowcaseL } from './ShowcaseL';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const render = (patch: Partial<LandingFlags> = {}) => renderToStaticMarkup(createElement(ShowcaseL, { flags: { ...ALL_ON, ...patch } }));
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const has = (html: string, text: string) => html.includes(escape(text));

describe('sample L: library and voice block', () => {
  it('renders both parts, with every step written out on the page and the windows as pictures', () => {
    const html = render();
    expect(html).toContain('data-region="资料库和文风"');
    expect(html).toContain('data-region="资料库"');
    expect(html).toContain('data-region="文风参考"');
    expect(has(html, L_SHOWCASE.title)).toBe(true);
    for (const part of [L_SHOWCASE_LIBRARY, L_SHOWCASE_VOICE]) {
      expect(has(html, part.title) && has(html, part.line)).toBe(true);
      for (const beat of part.beats) expect(has(html, beat.label) && has(html, beat.line)).toBe(true);
    }
    expect(html.match(/inert="" aria-hidden="true"/g)).toHaveLength(2);
    // The first step's windows: the real "我的文档" list and upload panel.
    expect(html).toContain('我常用的厨具清单.md');
    expect(html).toContain('上传文件');
  });

  it('reuses region 5\'s approved worry and answer as each part\'s heading and line', () => {
    const library = L_CARE.items.find(item => item.needs.includes('library'))!;
    const voice = L_CARE.items.find(item => item.needs.includes('voice'))!;
    expect([L_SHOWCASE_LIBRARY.title, L_SHOWCASE_LIBRARY.line]).toEqual([library.worry, library.does]);
    expect([L_SHOWCASE_VOICE.title, L_SHOWCASE_VOICE.line]).toEqual([voice.worry, voice.does]);
  });

  it('hides each part with its capability, and the whole block with both', () => {
    const noLibrary = render({ library: false });
    expect(noLibrary).not.toContain('data-region="资料库"');
    expect(noLibrary).toContain('data-region="文风参考"');
    const noVoice = render({ voice: false });
    expect(noVoice).toContain('data-region="资料库"');
    expect(noVoice).not.toContain('data-region="文风参考"');
    expect(render({ library: false, voice: false })).toBe('');
  });

  it('claims no firsts', () => {
    const html = render();
    expect(html).not.toMatch(/首个|唯一|第一/);
    expect(JSON.stringify([L_SHOWCASE, L_SHOWCASE_LIBRARY, L_SHOWCASE_VOICE])).not.toMatch(/首个|唯一|第一/);
  });
});
