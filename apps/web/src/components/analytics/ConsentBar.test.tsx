import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConsentSnapshot } from '@/lib/analytics/consent';
import { ConsentBar } from './ConsentBar';

const state = (patch: Partial<ConsentSnapshot>): ConsentSnapshot => ({
  ready: true, region: 'optin', choice: null, gpc: false, analytics: false, promptOpen: true, reopened: false, ...patch,
});
const render = (patch: Partial<ConsentSnapshot>, locale: 'zh-Hans' | 'zh-TW' = 'zh-Hans') =>
  renderToStaticMarkup(<ConsentBar consent={state(patch)} locale={locale} />);

describe('the consent bar (ANALYTICS-CONSENT)', () => {
  it('asks an opt-in visitor with two equal choices and no close button', () => {
    const html = render({});
    expect(html).toContain('aria-label="Cookie 同意"');
    expect(html).toContain('>仅必要</button>');
    expect(html).toContain('>接受</button>');
    expect(html).toContain('href="/cookies"');
    expect(html).not.toContain('aria-label="关闭"');
  });

  it('renders nothing before the browser state is read, or when nothing asks for it', () => {
    expect(render({ ready: false })).toBe('');
    expect(render({ region: 'optout', analytics: true, promptOpen: false })).toBe('');
  });

  it('reopened from "Cookie 设置": shows the current state and can be closed', () => {
    const html = render({ region: 'optout', analytics: true, reopened: true });
    expect(html).toContain('当前：已开启统计。');
    expect(html).toContain('aria-label="关闭"');
    expect(render({ choice: 'denied', reopened: true })).toContain('当前：仅必要。');
  });

  it('with GPC: says statistics stay off and offers no "接受"', () => {
    const html = render({ gpc: true, reopened: true });
    expect(html).toContain('GPC');
    expect(html).not.toContain('>接受</button>');
  });

  it('speaks Traditional Chinese on the Taiwan pages', () => {
    expect(render({}, 'zh-TW')).toContain('>僅必要</button>');
  });

  it('the site loads no Termly consent script any more', () => {
    const source = readFileSync(new URL('./SiteAnalytics.tsx', import.meta.url), 'utf8');
    expect(source.toLowerCase()).not.toContain('termly');
  });
});
