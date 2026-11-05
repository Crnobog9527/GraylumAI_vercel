import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyRound } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { StatusScreen, TAIWAN_LABELS } from '@/components/layout/StatusScreen';
import { AuthPageCard } from './AuthPageCard';
import { AuthCard, AuthHead, AuthShell } from './AuthShell';

const SOURCE = join(import.meta.dirname, '..', '..');

/** UI-UNIFY A-1: the sign-in pages share one light shell (public layer) instead of each writing its own dark page. */
describe('AuthShell', () => {
  it('renders a brand header that leads home, one h1 and the content in a card', () => {
    const html = renderToStaticMarkup(
      <AuthShell siteName="Graylum"><AuthCard><AuthHead title="登录到 Graylum" lead="说明" /><p>表单</p></AuthCard></AuthShell>);
    expect(html).toMatch(/<a[^>]*href="\/"/);
    expect(html).toContain('Graylum');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('表单');
  });
  it('AuthPageCard (forgot password, reset password) and StatusScreen (404, errors) use it; the Taiwan pages lead to /zh-tw', () => {
    const card = renderToStaticMarkup(createElement(AuthPageCard, { icon: KeyRound, title: '重置密码', description: '说明', children: '内容' }));
    expect(card).toMatch(/<a[^>]*href="\/"/);
    expect(card).toContain('重置密码');
    const status = renderToStaticMarkup(createElement(StatusScreen, { code: '404', title: '頁面不存在', description: '說明', icon: null, labels: TAIWAN_LABELS }));
    expect(status).toMatch(/<a[^>]*href="\/zh-tw"/);
    expect(status).toContain('404');
  });
  it('the pages do not bring their own dark page back (a literal from the old dark look in any of them fails)', () => {
    const pages = ['app/(zh-hans)/login/page.tsx', 'app/(zh-hans)/verify-email/page.tsx', 'app/(zh-hans)/forgot-password/page.tsx',
      'app/(zh-hans)/reset-password/page.tsx', 'app/(zh-hans)/maintenance/page.tsx', 'app/(zh-hans)/access-denied/page.tsx',
      'components/auth/AuthPageCard.tsx', 'components/auth/AuthStatusBanner.tsx', 'components/auth/AuthRedirectNotice.tsx', 'components/layout/StatusScreen.tsx'];
    for (const file of pages) {
      const text = readFileSync(join(SOURCE, file), 'utf8');
      expect(text, file).not.toMatch(/#070707|#f2c94c|#f8d25c|min-h-screen|100vh|rgba\(255,\s*255,\s*255|rgba\(255,\s*215,\s*0/);
    }
    for (const file of ['login', 'verify-email', 'maintenance', 'access-denied'])
      expect(readFileSync(join(SOURCE, `app/(zh-hans)/${file}/page.tsx`), 'utf8'), file).toContain("@/components/auth/AuthShell");
  });
});
