/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/components/misans-font', () => ({ MiSansFont: () => null }));
vi.mock('@/trpc/provider', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/lib/public-site', () => ({ getPublicSiteSettings: vi.fn() }));

import RouteError from './error';
import GlobalError from './global-error';
import NotFound from './not-found';
import RootLayout from './layout';
import { StatusScreen } from '@/components/layout/StatusScreen';

function findRetryHandler(node: ReactNode): unknown {
  if (!isValidElement(node)) return undefined;
  const props = (node as ReactElement<{ onClick?: unknown; children?: ReactNode }>).props;
  if (props.onClick) return props.onClick;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    const found = findRetryHandler(child);
    if (found) return found;
  }
  return undefined;
}

const serverError = Object.assign(new Error('relation "secret_table" does not exist'), { digest: 'abc123' });

describe('route error page', () => {
  it('shows a Chinese retry/home screen with the digest but not the raw message', () => {
    const html = renderToStaticMarkup(<RouteError error={serverError} retry={() => {}} />);
    expect(html).toContain('这个页面暂时无法显示');
    expect(html).toContain('重试');
    expect(html).toContain('返回首页');
    expect(html).toContain('href="/"');
    expect(html).toContain('错误编号：abc123');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('secret_table');
  });

  it('wires the retry button to the boundary retry callback', () => {
    const retry = vi.fn();
    const tree = StatusScreen({ code: 'x', title: 't', description: 'd', icon: null, onRetry: retry });
    expect(findRetryHandler(tree)).toBe(retry);
  });
});

describe('global error page', () => {
  it('renders its own zh-CN document with retry and home actions', () => {
    const html = renderToStaticMarkup(<GlobalError error={serverError} retry={() => {}} />);
    expect(html).toMatch(/^<html lang="zh-CN">/);
    expect(html).toContain('<body');
    expect(html).toContain('网站暂时无法显示');
    expect(html).toContain('重试');
    expect(html).toContain('返回首页');
    expect(html).not.toContain('secret_table');
  });
});

describe('not found page', () => {
  it('shows a Chinese 404 with a home link and no retry', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('404');
    expect(html).toContain('页面不存在');
    expect(html).toContain('返回首页');
    expect(html).not.toContain('重试');
    expect(html).not.toContain('role="alert"');
  });
});

describe('root layout', () => {
  it('declares the document language as zh-CN', () => {
    const html = renderToStaticMarkup(<RootLayout><p>child</p></RootLayout>);
    expect(html).toMatch(/^<html lang="zh-CN">/);
    expect(html).toContain('<p>child</p>');
  });
});
