import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GlobalBanner from './GlobalBanner';

function render(banner_link?: string) {
  return renderToStaticMarkup(createElement(GlobalBanner, {
    banners: [{ id: 'banner', title: 'Banner title', description: 'Details', banner_style: 'info', banner_link }],
  }));
}

describe('GlobalBanner link rendering', () => {
  it('renders HTTPS with a protected new tab', () => {
    const html = render('https://example.com/news');
    expect(html).toContain('href="https://example.com/news"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders a site path without opening a new tab', () => {
    const html = render('/marketplace');
    expect(html).toContain('href="/marketplace"');
    expect(html).not.toContain('target="_blank"');
  });

  it.each([
    undefined, '', '   ', 'javascript:alert(1)', 'data:text/html,test',
    'vbscript:msgbox(1)', '//example.com', '/\\example.com', 'https:example.com',
    'http://example.com', 'ftp://example.com',
  ])('renders legacy unsafe link %j as text with dismiss button', value => {
    const html = render(value);
    expect(html).toContain('Banner title');
    expect(html).toContain('Details');
    expect(html).toContain('aria-label="关闭公告"');
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toContain('lucide-chevron-right');
  });
});
