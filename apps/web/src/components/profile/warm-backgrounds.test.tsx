/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/opc/rail-view', () => ({ GlobalHeader: () => <header data-global-header="" /> }));
vi.mock('@/components/layout/LanguageSwitch', () => ({ LanguageSwitch: () => null }));

import { ProfileShell } from './ProfileShell';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const rule = (css: string, selector: string) => {
  const at = css.indexOf(selector + '{') >= 0 ? css.indexOf(selector + '{') : css.indexOf(selector + ' {');
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1);
};

// Owner 2026-11-12: the signed-in pages were plain white. The conversation gets a very faint light that must not draw the eye;
// the profile center may be livelier, with motion. Both respect "reduce motion", and the shared top bar is not restyled.
describe('the workbench canvas (conversation pages)', () => {
  const frame = read('../opc/workspace-frame.module.css');
  const canvas = frame.slice(frame.lastIndexOf('.workspace{background:'), frame.indexOf('}', frame.lastIndexOf('.workspace{background:')) + 1);

  it('carries the morning light on the canvas only, faintly, and does not move', () => {
    expect(canvas.match(/radial-gradient\(/g)).toHaveLength(3);
    // Every pool is weaker than a fifth: it tints the rail and the gaps, nothing is read on it.
    for (const alpha of [...canvas.matchAll(/rgba\(\d+,\d+,\d+,(\.\d+)\)/g)].map(match => Number(match[1]))) expect(alpha).toBeLessThanOrEqual(0.2);
    // Over the colour the first frame is painted in, so the page does not change colour as it loads.
    expect(canvas).toContain('#f7f7f7}');
    expect(canvas).not.toContain('animation');
  });

  it('leaves the reading panels white and the top bar as it was; the announcement carries its own light, not the canvas\'s', () => {
    expect(frame).toMatch(/\.center,\.right\{[^}]*background:#fff/);
    expect(frame).toContain('.global{height:60px;display:flex;align-items:center;gap:42px;padding:0 26px;background:#fff;border-bottom:1px solid #ededed}');
    // Owner 2026-11-12 redesigned the announcement ("现在这个一片灰再加一点字，就是太单调了"): it is no longer grey. It still has a
    // ground of its own, opaque, so the canvas behind the shell does not show through it (announcement.test.tsx holds its look).
    expect(frame).toMatch(/\.announcement\{[^}]*background:#fff1cf/);
    expect(frame).not.toMatch(/\.announcement\{[^}]*background:#efefef/);
    // …the landing page's light along it (gold, peach, lilac), in the 40px it always had.
    expect(frame).toMatch(/\.announcement\{[^}]*height:40px/);
    expect(frame).toMatch(/\.announcement::before\{[^}]*background:linear-gradient\(100deg,#fff1cf 0%,#ffe2d6 16\.66%,#efe7fd 33\.33%/);
  });

  it('gives only the new-conversation page a breath of light at its head; it stays white beneath', () => {
    const start = read('../../app/(zh-hans)/app/positioning/start-work.module.css');
    const glow = start.slice(start.lastIndexOf('.page{background:'));
    expect(glow.slice(0, glow.indexOf('}') + 1)).toMatch(/radial-gradient\([^)]*rgba\(255,178,56,\.1\d?\)[\s\S]*#fff\}$/);
  });
});

describe('the profile center\'s backdrop', () => {
  const css = read('./profile-backdrop.module.css');

  it('is a decoration behind the page: hidden from assistive technology, never in the way of a click', () => {
    const html = renderToStaticMarkup(<ProfileShell><p>内容</p></ProfileShell>);
    expect(html).toMatch(/<div class="[^"]*" aria-hidden="true"><\/div><header data-global-header="">/);
    expect(html).toContain('<p>内容</p>');
    expect(rule(css, '.backdrop')).toContain('pointer-events: none');
    expect(rule(css, '.backdrop')).toContain('z-index: -1');
  });

  it('moves only by transform and opacity, slowly, and stands still when the system asks for less motion', () => {
    const frames = css.slice(css.indexOf('@keyframes'), css.indexOf('@media'));
    for (const declaration of [...frames.matchAll(/\{\s*([a-z-]+):/g)].map(match => match[1])) expect(['transform', 'opacity']).toContain(declaration);
    expect(css).toMatch(/animation: profile-pools-a 2\d s|animation: profile-pools-a 2\ds/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const selector of ['.backdrop::before', '.backdrop::after', '.content']) expect(reduced).toContain(selector);
    expect(reduced).toContain('animation: none');
  });
});
