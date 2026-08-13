import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import UpdatesSection from './UpdatesSection';

const baseAnnouncement = {
  id: 'announcement-1',
  title: '平台更新',
  description: '查看本次更新详情',
};

function renderAnnouncement(linkUrl?: string | null) {
  return renderToStaticMarkup(
    createElement(UpdatesSection, {
      announcements: [{
        ...baseAnnouncement,
        link_url: linkUrl,
      }],
    }),
  );
}

describe('UpdatesSection announcement links', () => {
  it('renders an internal announcement as a semantic link', () => {
    const markup = renderAnnouncement('/marketplace?module=featured#details');

    expect(markup).toContain('href="/marketplace?module=featured#details"');
    expect(markup).toContain('card-clickable');
    expect(markup).toContain('lucide-arrow-up-right');
    expect(markup).not.toContain('target="_blank"');
  });

  it('renders a valid HTTP(S) URL as a protected external link', () => {
    for (const url of ['https://example.com/releases', 'http://example.com/releases']) {
      const markup = renderAnnouncement(url);

      expect(markup).toContain(`href="${url}"`);
      expect(markup).toContain('target="_blank"');
      expect(markup).toContain('rel="noopener noreferrer"');
      expect(markup).toContain('card-clickable');
      expect(markup).toContain('lucide-arrow-up-right');
    }
  });

  it('keeps announcements without a link non-interactive', () => {
    for (const url of [undefined, null, '', '   ']) {
      const markup = renderAnnouncement(url);

      expect(markup).not.toContain('<a ');
      expect(markup).not.toContain('card-clickable');
      expect(markup).not.toContain('lucide-arrow-up-right');
    }
  });

  it('rejects dangerous or unsupported announcement URLs', () => {
    const unsafeUrls = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//example.com/releases',
      '/\\example.com/releases',
      'https:example.com/releases',
      'https:\\example.com/releases',
      'ftp://example.com/releases',
      'not-a-url',
    ];

    for (const url of unsafeUrls) {
      const markup = renderAnnouncement(url);

      expect(markup).not.toContain('<a ');
      expect(markup).not.toContain('card-clickable');
      expect(markup).not.toContain('lucide-arrow-up-right');
    }
  });
});
