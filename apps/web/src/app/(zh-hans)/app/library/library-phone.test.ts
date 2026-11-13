/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../..');
const FILES = ['app/(zh-hans)/app/library/library.module.css', 'components/library/my-documents.module.css', 'components/voice/my-voice.module.css'];
const read = (file: string) => readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Every block of a stylesheet written for one media query, joined. */
const blocks = (css: string, query: string) => [...css.matchAll(/@media\s*([^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  .filter(match => match[1].trim() === query).map(match => match[2]).join('\n');
const PHONE = '(max-width: 639px)';
const px = (value: string) => Number(value.replace('px', ''));

// Owner 2026-11-12, phone plan A: "把它当成一个原生的网页 APP 界面来做……不要像现在这样，就是生硬地挤压". The library on a phone.
describe('the library on a phone, laid out the way an app is', () => {
  it.each(FILES)('%s: has a phone layout, and everything written for it is for under 640px only', file => {
    const raw = readFileSync(join(SRC, file), 'utf8');
    expect(blocks(read(file), PHONE).length, 'a phone block').toBeGreaterThan(400);
    // The phone layout was added after everything else, under its own heading. From that heading on, the file is nothing but
    // blocks for under 640px and the one keyframe a sheet rises by: no rule a computer or a tablet reads was written there.
    const from = raw.indexOf('* A phone (under 640px; Owner 2026-11-12, phone plan A');
    expect(from).toBeGreaterThan(0);
    const added = raw.slice(from).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\s\S]*?\*\//, '');
    const rest = added.replace(/@media \(max-width: 639px\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
      .replace(/@keyframes (?:library|documents)-sheet-rise[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').trim();
    expect(rest).toBe('');
  });

  it.each(FILES)('%s: on a phone every button and menu is a thumb\'s height, and a text box or a menu is typed at 16px', file => {
    const phone = blocks(read(file), PHONE);
    const rules = [...phone.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(rule => ({ selectors: rule[1].split(',').map(part => part.trim()), body: rule[2] }));
    const controls = rules.filter(rule => rule.selectors.some(part => /(?:button|select|input|\.pick|\ba|label)(?:\[[^\]]*\])?$/.test(part)) && /min-height: \d+px/.test(rule.body));
    expect(controls.length).toBeGreaterThanOrEqual(2);
    for (const rule of controls) expect(px(rule.body.match(/min-height: (\d+)px/)![1]), rule.selectors.join(', ')).toBeGreaterThanOrEqual(40);
    // A text box or a menu under 16px makes a phone zoom the page in when it is touched.
    const fields = rules.filter(rule => rule.selectors.every(part => /(?:input|select|textarea)$/.test(part)) && /font-size:/.test(rule.body));
    expect(fields.length).toBeGreaterThanOrEqual(1);
    for (const rule of fields) expect(rule.body, rule.selectors.join(', ')).toMatch(/font-size: 16px/);
  });

  it.each(FILES.slice(0, 2))('%s: a dialog is a sheet from the foot of the screen, and it rises only where motion is welcome', file => {
    const css = read(file);
    const phone = blocks(css, PHONE);
    expect(phone).toMatch(/\.backdrop \{ place-items: end stretch; padding: 0; \}/);
    expect(phone).toMatch(/\.dialog \{[^}]*width: 100%;[^}]*border-radius: 24px 24px 0 0;[^}]*env\(safe-area-inset-bottom/s);
    expect(phone).toMatch(/\.dialog::before \{/);
    expect(phone).not.toMatch(/animation|transition/);
    expect(blocks(css, `${PHONE} and (prefers-reduced-motion: no-preference)`)).toMatch(/\.dialog \{ animation: (?:library|documents)-sheet-rise/);
  });

  it('keeps the page\'s own marks: the four kinds of material are tabs, and a topic\'s details are a dialog inside the page', () => {
    const page = readFileSync(join(SRC, 'app/(zh-hans)/app/library/page.tsx'), 'utf8');
    expect(page).toContain('<main className={styles.page}>');
    expect(page).toContain('<nav className={styles.tabs} role="tablist" aria-label="资料库分类">');
    for (const mark of ['styles.catalogNav', 'styles.statusTabs', 'styles.strategyCards', 'styles.itemOpen', 'styles.pagination']) expect(page, mark).toContain(mark);
  });
});
