/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { PUBLIC_PAGES } from '@/lib/seo/public-pages';
import { REFUND_PAGE } from '@/lib/seo/content/refund';
import { RefundPage } from './RefundPage';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

it('renders the refund summary with one H1, the 7-day and 6% rules, and the pointer to the formal terms', () => {
  const html = renderToStaticMarkup(<RefundPage />);
  expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  for (const text of ['7 天', '6% 手续费', '客服工单', '续费', '以《服务条款》和正式的退款政策为准']) expect(html).toContain(text);
  expect(html).toContain('href="/terms"');
  expect(html).not.toContain('href="/"');
  expect(PUBLIC_PAGES.some(page => page.path === REFUND_PAGE.path)).toBe(true);
});
