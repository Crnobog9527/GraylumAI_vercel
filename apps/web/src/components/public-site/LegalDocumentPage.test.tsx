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
});
