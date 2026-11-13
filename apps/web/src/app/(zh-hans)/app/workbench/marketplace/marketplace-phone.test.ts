/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(__dirname, 'workspace-marketplace.module.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const blocks = (query: string) => [...css.matchAll(/@media\s*([^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  .filter(match => match[1].trim() === query).map(match => match[2]).join('\n');
const phone = blocks('(max-width: 639px)');

// Owner 2026-11-12, phone plan A: the phone is laid out the way an app is. The marketplace on a phone.
describe('the marketplace on a phone', () => {
  it('shows a function\'s details as a sheet from the foot of the screen, only once a function is chosen', () => {
    // Before, the details sat under the whole list: choosing a function changed something a long way below the screen.
    expect(phone).toContain('.page .detail { display: none; }');
    expect(phone).toMatch(/\.page \.detail\[data-open\] \{\s*position: fixed; inset: auto 0 0;[^}]*border-radius: 24px 24px 0 0;[^}]*overflow-y: auto;/);
    expect(phone).toMatch(/\.page \.detail\[data-open\] \{[^}]*env\(safe-area-inset-bottom/);
    expect(page).toContain("<aside className={styles.detail} aria-label=\"功能详情\" data-open={selected?'':undefined}>");
  });

  it('the sheet closes by its × and by a touch outside, and a computer shows neither control', () => {
    expect(css).toContain('.scrim,.close{display:none}');
    expect(phone).toMatch(/\.page \.scrim \{ display: block; position: fixed; inset: 0;/);
    expect(phone).toMatch(/\.page \.close \{[^}]*width: 44px; height: 44px;/);
    expect(page).toContain("{selected&&<button type=\"button\" className={styles.scrim} aria-label=\"关闭功能详情\" tabIndex={-1} onClick={()=>setSelected('')}/>}");
    expect(page).toContain("<button type=\"button\" className={styles.close} aria-label=\"关闭功能详情\" onClick={()=>setSelected('')}>");
  });

  it('is two functions to a row, with controls a thumb\'s height and the search box typed at 16px', () => {
    expect(phone).toContain('.page .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }');
    expect(phone).toMatch(/\.page \.search input \{ height: 46px; font-size: 16px; \}/);
    for (const [, selector, height] of phone.matchAll(/([^{}]+)\{[^{}]*?min-height: (\d+)px/g)) {
      if (/button|\ba\b|\.start/.test(selector)) expect(Number(height), selector.trim()).toBeGreaterThanOrEqual(40);
    }
    expect(phone).toMatch(/\.page \.start \{[^}]*min-height: 50px/);
  });

  it('adds nothing a computer reads but the two hidden controls, and the sheet rises only where motion is welcome', () => {
    const from = raw.indexOf('/* The two controls that close a phone\'s details sheet');
    expect(from).toBeGreaterThan(0);
    const rest = raw.slice(from).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media \(max-width: 639px\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
      .replace(/@keyframes marketplace-sheet-rise[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').trim();
    expect(rest).toBe('.scrim,.close{display:none}');
    expect(phone).not.toMatch(/animation|transition/);
    expect(blocks('(max-width: 639px) and (prefers-reduced-motion: no-preference)')).toContain('.page .detail[data-open] { animation: marketplace-sheet-rise');
  });
});
