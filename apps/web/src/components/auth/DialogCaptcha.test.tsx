import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn() }));

import { DialogCaptcha } from './DialogCaptcha';
import { SecuritySettingsCard } from '@/components/profile/SecuritySettingsCard';

const noop = () => undefined;

describe('DialogCaptcha', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('renders a container for the explicit widget when CAPTCHA is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', 'site-key');
    const html = renderToStaticMarkup(<DialogCaptcha onToken={noop} onExpired={noop} onUnavailable={noop} />);
    expect(html).toContain('data-dialog-captcha');
    // Explicit rendering only: no implicit page-scan class that hCaptcha would render on load.
    expect(html).not.toContain('h-captcha');
  });

  it('renders nothing when CAPTCHA is not configured', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', '');
    expect(renderToStaticMarkup(<DialogCaptcha onToken={noop} onExpired={noop} onUnavailable={noop} />)).toBe('');
  });
});

describe('SecuritySettingsCard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('no longer puts a CAPTCHA widget on the page outside the dialog', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', 'site-key');
    const html = renderToStaticMarkup(<SecuritySettingsCard user={{ email: 'a@example.test', auth_provider: 'email' }} />);
    expect(html).toContain('修改密码');
    expect(html).not.toContain('h-captcha');
    expect(html).not.toContain('data-dialog-captcha');
    expect(html).not.toContain('hcaptcha.com');
  });
});
