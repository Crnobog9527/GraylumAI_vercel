import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooterJ } from './SiteFooterJ';

describe('the landing footer\'s consent entry (ANALYTICS-CONSENT)', () => {
  it('offers "Cookie 设置" as the button that reopens the consent bar, in place of the static cookie link', () => {
    for (const onlyBuilt of [true, false]) {
      const html = renderToStaticMarkup(<SiteFooterJ onlyBuilt={onlyBuilt} />);
      expect(html).toContain('>Cookie 设置</button>');
      expect(html).not.toContain('href="/privacy#cookies"');
      expect(html).not.toContain('不要出售或分享我的个人信息');
    }
  });
});
