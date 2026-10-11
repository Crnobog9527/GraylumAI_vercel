/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { BRAND_IDENTITY_INSTRUCTIONS, BRAND_REPLY_EN, BRAND_REPLY_ZH, withBrandIdentity } from './brandIdentity';
import { buildWorkbenchMessages } from '../artifacts/generation';

it('carries the Owner-approved replies verbatim (版本一, 2026-10-12)', () => {
  expect(BRAND_REPLY_ZH).toBe('我是 Graylum 的 AI 社媒策略师，背后整合了多家领先的 AI 技术，具体用了哪些属于内部技术细节，不对外公开。我们继续聊你的账号吧？');
  expect(BRAND_REPLY_EN).toBe("I'm Graylum's AI social media strategist, built on a combination of leading AI technologies. The specific technical details are internal and not shared publicly. Shall we get back to your account?");
  expect(BRAND_IDENTITY_INSTRUCTIONS).toContain(BRAND_REPLY_ZH);
  expect(BRAND_IDENTITY_INSTRUCTIONS).toContain(BRAND_REPLY_EN);
});

it('never claims a self-built model and forbids confirming any vendor guess', () => {
  expect(BRAND_REPLY_ZH).not.toMatch(/自研|自主研发/);
  expect(BRAND_REPLY_EN).not.toMatch(/our own model|in-house/i);
  expect(BRAND_IDENTITY_INSTRUCTIONS).toMatch(/never confirm or deny a guess/);
});

it('prepends only when the switch is on, leaving the rest byte-identical', () => {
  expect(withBrandIdentity('Skill', false)).toBe('Skill');
  expect(withBrandIdentity('Skill', true)).toBe(BRAND_IDENTITY_INSTRUCTIONS + '\nSkill');
});

it('workbench generation keeps one system message and leads it with the identity when on', () => {
  const off = buildWorkbenchMessages('METHOD', { a: 1 }, 'reply');
  const on = buildWorkbenchMessages('METHOD', { a: 1 }, 'reply', true);
  expect(on).toHaveLength(2);
  expect(on[0].content).toBe(BRAND_IDENTITY_INSTRUCTIONS + '\n' + off[0].content);
  expect(on[1]).toEqual(off[1]);
});
