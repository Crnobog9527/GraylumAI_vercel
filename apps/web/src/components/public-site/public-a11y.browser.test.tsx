/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Regression guard for the public pages' accessibility (WCAG 2.1 AA, see /accessibility): renders public components
// to static HTML and runs axe in a local headless Chromium. No staging, no network. Colour contrast is not checked
// here (the markup is rendered without the compiled CSS); the dated staging scans cover it.
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { compareHans, compareTw } from '@/lib/seo/content/compare';
import { ArticlePage } from './ArticlePage';
import { FaqPage } from './FaqPage';
import { PublicShell } from './PublicShell';
import { RefundPage } from './RefundPage';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const PAGES: [string, () => React.ReactElement, string][] = [
  ['refund', () => <RefundPage supportEmail="support@example.com" />, 'zh-Hans'],
  ['faq', () => <FaqPage supportEmail="support@example.com" />, 'zh-Hans'],
  ['compare (zh-Hans)', () => <ArticlePage content={compareHans()} supportEmail="support@example.com" />, 'zh-Hans'],
  ['compare (zh-TW)', () => <ArticlePage content={compareTw()} supportEmail="support@example.com" />, 'zh-TW'],
  ['public shell (light)', () => <PublicShell locale="zh-Hans" supportEmail="support@example.com"><h1>x</h1></PublicShell>, 'zh-Hans'],
  ['public shell (dark, zh-TW)', () => <PublicShell locale="zh-TW" tone="dark"><h1>x</h1></PublicShell>, 'zh-TW'],
];

for (const [name, render, lang] of PAGES) {
  it(`${name} has no critical or serious axe violations`, async () => {
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${name}</title></head><body><main>${renderToStaticMarkup(render())}</main></body></html>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.setContent(html);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .disableRules(['color-contrast', 'region', 'landmark-one-main', 'page-has-heading-one'])
        .analyze();
      const serious = result.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
      expect(serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join('; ')}`)).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30000);
}

it('footer links to the accessibility statement', () => {
  expect(renderToStaticMarkup(<PublicShell locale="zh-Hans" supportEmail="support@example.com"><p /></PublicShell>)).toContain('href="/accessibility"');
});
