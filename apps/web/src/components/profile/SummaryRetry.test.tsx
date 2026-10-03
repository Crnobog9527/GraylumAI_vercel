/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
const { SummaryStatValue } = await import('./SummaryRetry');

const render = (query: { data?: { totalSpent: number }; isError?: boolean; isFetching?: boolean }) =>
  renderToStaticMarkup(<SummaryStatValue query={{ ...query, refetch: () => undefined }} pick={(s) => s.totalSpent} />);

describe('summary value with retry', () => {
  it('shows the number and no button once read', () => {
    const html = render({ data: { totalSpent: 1234 } });
    expect(html).toContain('1,234');
    expect(html).not.toContain('<button');
  });

  it('shows an ellipsis, not a spinner loop or 0, while reading', () => {
    const html = render({ isFetching: true });
    expect(html).toContain('…');
    expect(html).not.toContain('<button');
  });

  it('shows a readable failure and a retry button after retries gave up', () => {
    const html = render({ isError: true });
    expect(html).toContain('读取失败');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>.*重试<\/button>/);
    expect(html).not.toContain('disabled=""');
  });

  it('disables the button while the manual retry runs', () => {
    const html = render({ isError: true, isFetching: true });
    expect(html).toContain('正在重试');
    expect(html).toContain('disabled=""');
  });
});
