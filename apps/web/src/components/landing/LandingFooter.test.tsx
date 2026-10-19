/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import LandingFooter from './LandingFooter';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/analytics/ConsentPreferenceLinks', () => ({ ConsentPreferenceLinks: () => null }));

it('links the refund policy from the legal column, like the other public footers', () => {
  const html = renderToStaticMarkup(<LandingFooter siteName="Graylum" supportEmail="support@example.com" />);
  expect(html).toContain('href="/refund"');
  expect(html).toContain('退款政策');
});
