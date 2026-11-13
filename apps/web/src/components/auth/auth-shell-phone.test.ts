/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(__dirname, 'auth-shell.module.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const phone = [...css.matchAll(/@media\s*\(max-width: 639px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(match => match[1]).join('\n');
const rule = (selector: string) => (phone.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) ?? [])[1] ?? '';

// Owner 2026-11-12, phone plan A: the phone is laid out the way an app is, in the landing page's look. The sign-in pages.
describe('the sign-in pages on a phone', () => {
  it('lay the landing page\'s light behind the top of the screen, behind everything and without widening the page', () => {
    expect(rule('.shell')).toMatch(/position: relative; isolation: isolate; overflow-x: clip/);
    const light = rule('.shell::before');
    expect(light).toMatch(/position: absolute; inset: 0 0 auto; z-index: -1; height: 440px; pointer-events: none/);
    expect(light.match(/radial-gradient/g)).toHaveLength(3);
    // Faint: no pool of it is stronger than a quarter, so the text on it reads as it did.
    for (const [, alpha] of light.matchAll(/rgba\(\d+, \d+, \d+, (\.\d+)\)/g)) expect(Number(alpha)).toBeLessThanOrEqual(0.25);
  });

  it('start the card under the name and keep it there, instead of centring it in the screen\'s height', () => {
    // Centred, the card's top moved whenever its height did (登录 / 注册, 手机号 / 邮箱, an error line appearing).
    expect(rule('.column')).toBe(' margin: 0 auto; ');
    expect(css).toMatch(/\.column \{ width: min\(100%, 480px\); margin: auto; \}/);
  });

  it('keep clear of the notch and the home indicator, and make the two choices in the pill a thumb\'s height', () => {
    expect(rule('.header')).toContain('env(safe-area-inset-top, 0px)');
    expect(rule('.stage')).toContain('env(safe-area-inset-bottom, 0px)');
    expect(rule('.segmentItem')).toBe(' min-height: 44px; ');
  });

  it('change nothing a computer or a tablet reads, and move nothing', () => {
    const from = raw.indexOf('* A phone (under 640px; Owner 2026-11-12, phone plan A');
    expect(from).toBeGreaterThan(0);
    const added = raw.slice(from).replace(/^[\s\S]*?\*\//, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(added.replace(/@media \(max-width: 639px\) \{(?:[^{}]|\{[^{}]*\})*\}/, '').trim()).toBe('');
    expect(phone).not.toMatch(/animation|transition/);
  });
});
