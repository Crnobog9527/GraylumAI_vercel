/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(__dirname, 'data-review.module.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const block = (query: string) => [...css.matchAll(/@media\s*([^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  .filter(match => match[1].trim() === query).map(match => match[2]).join('\n');
const phone = block('(max-width: 639px)');
const rule = (selector: string) => (phone.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) ?? [])[1] ?? '';

// Owner 2026-11-12, phone plan A: the phone is laid out the way an app is. What the data review lacked beside the other pages.
describe('the data review on a phone', () => {
  it('names the page large, as the other pages of the phone do, and keeps small print readable', () => {
    expect(rule('.head h1')).toMatch(/font-size: 26px;\s*font-weight: 700/);
    expect(rule('.intro')).toContain('font-size: 13px');
    expect(phone).toMatch(/\.kpiNote,\s*\.metric dt,\s*\.stateTag \{\s*font-size: 12px/);
  });

  it('types menus and text boxes at 16px, so the phone does not zoom the page in when one is touched', () => {
    expect(rule('.page .select')).toMatch(/height: 44px;[\s\S]*font-size: 16px/);
    expect(phone).toMatch(/\.page input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='file'\]\),\s*\.page textarea \{\s*font-size: 16px/);
  });

  it('makes the chips and the shared kit\'s small buttons a thumb\'s height', () => {
    expect(rule('.page .chip')).toContain('min-height: 40px');
    expect(rule('.page .postMore')).toContain('min-height: 40px');
    expect(phone).toMatch(/\.page \.benchmarkForm input,[\s\S]*\.page \.reviewSideTitle button \{\s*min-height: 44px/);
  });

  it('gives the forms that add an account and connect one boxes, buttons and tick lines a thumb can hit', () => {
    expect(phone).toMatch(/\.page \.formStack input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='file'\]\),\s*\.page \.formStack button:not\(\[role='checkbox'\]\) \{\s*min-height: 44px/);
    expect(phone).toMatch(/\.page \.formStack \.check,\s*\.page \.radios label \{[^}]*min-height: 40px/);
    expect(rule('.page .radios input')).toMatch(/width: 20px;\s*height: 20px/);
    // The forms' own boxes are the ones the rule reaches: both keep their fields inside `.formStack`.
    for (const form of ['AddAccountForm.tsx', 'ConnectForm.tsx']) {
      expect(readFileSync(join(__dirname, form), 'utf8')).toMatch(/className=\{[^>]*styles\.formStack/);
    }
  });

  it('adds only a block for under 640px, with no motion, after the page\'s own narrow layout (700px), which stays', () => {
    const from = raw.indexOf('* A phone (under 640px; Owner 2026-11-12, phone plan A');
    expect(from).toBeGreaterThan(0);
    const added = raw.slice(from).replace(/^[\s\S]*?\*\//, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(added.startsWith('@media (max-width: 639px) {')).toBe(true);
    expect(added.replace(/@media \(max-width: 639px\) \{(?:[^{}]|\{[^{}]*\})*\}/, '').trim()).toBe('');
    expect(phone).not.toMatch(/animation|transition/);
    expect(block('(max-width: 700px)')).toContain('.charts');
  });
});
