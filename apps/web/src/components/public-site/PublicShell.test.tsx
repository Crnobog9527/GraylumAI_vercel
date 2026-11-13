/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import light from '@/components/design/light-tokens.module.css';
import { PublicShell } from './PublicShell';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/analytics/ConsentPreferenceLinks', () => ({ ConsentPreferenceLinks: () => null }));

const render = (props: Partial<React.ComponentProps<typeof PublicShell>> = {}) =>
  renderToStaticMarkup(<PublicShell locale="zh-Hans" supportEmail="support@example.com" {...props}><h1>页面内容</h1></PublicShell>);

it('wraps the page in header, main and footer, with the tone on the root', () => {
  const light = render();
  expect(light).toContain('data-tone="light"');
  expect(light).toMatch(/<header[\s\S]*<main[\s\S]*页面内容[\s\S]*<\/main>[\s\S]*<footer/);
  expect(render({ tone: 'dark' })).toContain('data-tone="dark"');
});

it('puts the light token class on the light tone only (no light aliases leak into dark pages)', () => {
  expect(render()).toContain(light.light);
  expect(render({ tone: 'dark' })).not.toContain(light.light);
});

// Owner 2026-11-14 (PUBLIC-SITE): the MiSans notice moves from the footer to the terms page (LegalDocumentPage.test.tsx).
it('no longer carries the font licence notice in the footer', () => {
  expect(render()).not.toContain('MiSans');
  expect(render({ locale: 'zh-TW' })).not.toContain('MiSans');
});

it('gives the light tone the home page backdrop and its first light; the dark tone has neither', () => {
  const html = render();
  expect(html).toMatch(/data-tone="light" data-zone="hero"/);
  expect(html).toMatch(/data-zone="final"><footer/);
  expect(render({ locale: 'zh-TW' })).toMatch(/<footer[^>]*data-zone="final"/);
  const dark = render({ tone: 'dark' });
  expect(dark).not.toContain('data-zone');
});

it('keeps the mobile menu without client JS where this shell draws the header (zh-TW, dark tone): a details with a named summary', () => {
  const html = render({ tone: 'dark' });
  expect(html).toMatch(/<details[^>]*><summary[^>]*aria-label="菜单"/);
  expect(html).toContain('aria-label="主导航"');
});

// Owner 2026-11-14 (PUBLIC-SITE): the Simplified light pages carry the home page's own header and footer.
it('gives the Simplified light pages the home page header and footer', () => {
  const html = render();
  expect(html).toContain('href="/faq"');
  expect(html).toContain('data-header-cta=""');
  expect(html).toContain('data-region="页脚"');
  expect(render({ locale: 'zh-TW' })).not.toContain('data-header-cta');
  expect(render({ tone: 'dark' })).not.toContain('data-header-cta');
});

it('links the header, the sign-in and the sign-up button wording the production home page shows', () => {
  const html = render();
  expect(html).toContain('href="/features"');
  expect(html).toContain('href="/pricing"');
  expect(html).toContain('href="/login?lang=zh-Hans"');
  expect(html).toContain('免费和教练聊聊');
});

it('serves zh-TW with its own wording and the language switch in the footer', () => {
  const html = render({ locale: 'zh-TW', alternates: { 'zh-Hans': '/about' } });
  expect(html).toContain('href="/login?lang=zh-Hant"');
  expect(html).toContain('href="/about"');
  expect(html).not.toContain('免费和教练聊聊');
});

it('keeps the footer links search engines follow: company, legal, refund and accessibility', () => {
  const html = render();
  for (const href of ['/about', '/contact', '/faq', '/terms', '/privacy', '/refund', '/cookies', '/accessibility']) {
    expect(html).toContain(`href="${href}"`);
  }
  expect(html).toContain('mailto:support@example.com');
});

it('stays a server component (public pages ship no client JS for their chrome; the backdrop is its own client island)', () => {
  const source = readFileSync(join(__dirname, 'PublicShell.tsx'), 'utf8');
  expect(source).not.toMatch(/['"]use client['"]/);
  expect(source).not.toMatch(/\buse(State|Effect|Ref)\b/);
});

// The public values live twice (the home page's --j-*, the shared --pub-*) until the home page reads --pub-*; this keeps them equal.
it('keeps --pub-* equal to the home page values (DESIGN.md crosswalk)', () => {
  const root = join(__dirname, '..');
  const tokens = readFileSync(join(root, 'design/light-tokens.module.css'), 'utf8');
  const home = readFileSync(join(root, 'landing/preview-j/j.module.css'), 'utf8');
  const value = (css: string, name: string) => {
    const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
    expect(match, name).not.toBeNull();
    return match![1].replace(/\s+/g, ' ').trim();
  };
  const pairs: [string, string][] = [
    ['--pub-canvas', '--j-canvas'], ['--pub-ink', '--j-ink'], ['--pub-body', '--j-body'], ['--pub-muted', '--j-muted'],
    ['--pub-line', '--j-line'], ['--pub-gold-text', '--j-gold-text'],
  ];
  for (const [pub, j] of pairs) expect(value(tokens, pub), pub).toBe(value(home, j));
  expect(value(tokens, '--pub-action')).toBe(value(home, '--j-ink'));
  const shadow = (css: string, name: string) => value(css, name).replace(/\s*,\s*/g, ',').replace(/\b0\./g, '.');
  expect(shadow(tokens, '--pub-shadow-feature')).toBe(shadow(home, '--j-shadow'));
});
