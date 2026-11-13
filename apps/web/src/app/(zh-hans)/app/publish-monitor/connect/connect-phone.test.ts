/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'connect-phone.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();
const view = readFileSync(join(__dirname, 'connect-view.tsx'), 'utf8');
const rule = (selector: string) => (css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)) ?? [])[1] ?? '';

// Owner 2026-11-12, phone plan A: the phone is laid out the way an app is. The account confirmation page borrows the
// publish page's look, whose phone layer covers the canvas, the head and the card; this is what the page alone has.
describe('the account confirmation page on a phone', () => {
  it('has rules for under 640px only, with no motion, so a computer and a tablet keep the page as it was', () => {
    expect(css.startsWith('@media (max-width: 639px) {')).toBe(true);
    expect(css.replace(/@media \(max-width: 639px\) \{(?:[^{}]|\{[^{}]*\})*\}/, '').trim()).toBe('');
    expect(css).not.toMatch(/animation|transition/);
  });

  it('names the page in every rule, so each wins over the borrowed rule whichever file loads later', () => {
    const selectors = [...css.matchAll(/^\s*(\.[^{@]+?)\s*\{/gm)].map(match => match[1]);
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) expect(selector.startsWith('.page .')).toBe(true);
  });

  it('makes an account choice, the daily-update line and the two buttons a thumb\'s size', () => {
    expect(rule('.page .choice')).toMatch(/min-height: 52px;[^}]*font-size: 15px/);
    expect(rule('.page .choice input')).toMatch(/width: 20px; height: 20px/);
    expect(rule('.page .check')).toContain('min-height: 44px');
    expect(rule('.page .actions')).toContain('grid-template-columns: 2fr 1fr');
    expect(rule('.page .actions > button')).toMatch(/height: 48px; border-radius: 999px/);
  });

  it('is hooked to the page, the choices, the daily-update line and the buttons, beside the borrowed classes', () => {
    expect(view).toContain("import phone from './connect-phone.module.css';");
    for (const [borrowed, own] of [['page', 'page'], ['choices', 'choices'], ['choice', 'choice'], ['check', 'check'], ['rowActions', 'actions']]) {
      expect(view).toContain(`className={\`\${styles.${borrowed}} \${phone.${own}}\`}`);
    }
    // The main button stays first in the row: it is the wider of the two.
    expect(view.indexOf('确认连接</Button>')).toBeLessThan(view.indexOf('>取消</Button>'));
  });
});
