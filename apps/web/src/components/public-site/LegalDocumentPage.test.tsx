/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { LegalDocumentPage } from './LegalDocumentPage';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/analytics/ConsentPreferenceLinks', () => ({ ConsentPreferenceLinks: () => null }));

it('shows the document inside the public site chrome with the English-text notice', () => {
  const html = renderToStaticMarkup(<LegalDocumentPage name="terms" />);
  expect(html).toContain('<h1>Terms of Service</h1>');
  expect(html).toContain('本页是英文法律文本');
  expect(html).toContain('Sheridan County, Wyoming');
  // The English text sits inside the Chinese page chrome, so it carries its own language.
  expect(html).toContain('<div lang="en"');
});

// Owner 2026-11-14 (PUBLIC-SITE): the MiSans licence notice left the footer for the terms page, with the licence link.
it('carries the font licence notice under the terms, outside the English document, and only there', () => {
  const terms = renderToStaticMarkup(<LegalDocumentPage name="terms" />);
  expect(terms).toContain('本网站使用 MiSans 字体，版权归小米所有。');
  expect(terms).toMatch(/<a href="\/fonts\/misans\/LICENSE.pdf"[^>]*>字体许可协议<\/a>/);
  expect(terms.indexOf('MiSans')).toBeGreaterThan(terms.indexOf('Sheridan County, Wyoming'));
  expect(renderToStaticMarkup(<LegalDocumentPage name="privacy" />)).not.toContain('MiSans');
});
