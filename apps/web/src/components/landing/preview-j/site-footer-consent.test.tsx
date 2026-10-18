import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.resetModules(); vi.doUnmock('@/lib/analytics/config'); });

const footer = async (termlyWebsiteUuid: string | null) => {
  vi.doMock('@/lib/analytics/config', async importOriginal => {
    const original = await importOriginal<typeof import('@/lib/analytics/config')>();
    return { ...original, ANALYTICS_CONFIG: { ...original.ANALYTICS_CONFIG, termlyWebsiteUuid } };
  });
  const { SiteFooterJ } = await import('./SiteFooterJ');
  return renderToStaticMarkup(<SiteFooterJ onlyBuilt />);
};

describe('the landing footer\'s consent entries (review on #1088)', () => {
  it('offers Termly\'s two entries in place of the static cookie link once Termly is in', async () => {
    const html = await footer('00000000-0000-4000-8000-000000000000');
    expect(html).toContain('>Cookie 设置</button>');
    expect(html).toContain('>不要出售或分享我的个人信息</button>');
    expect(html).not.toContain('href="/privacy#cookies"');
  });

  it('keeps the static cookie link without Termly', async () => {
    const html = await footer(null);
    expect(html).toContain('href="/privacy#cookies"');
    expect(html).not.toContain('不要出售或分享我的个人信息');
  });
});
