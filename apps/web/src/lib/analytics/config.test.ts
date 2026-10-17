import { describe, expect, it } from 'vitest';
import { gtagScriptUrl, parseAnalyticsConfig, termlyScriptUrl } from './config';

describe('parseAnalyticsConfig', () => {
  it('turns everything off when nothing is configured', () => {
    expect(parseAnalyticsConfig({})).toEqual({ termlyWebsiteUuid: null, gaMeasurementId: null, vercelCategory: 'analytics' });
  });

  it('accepts well-formed public IDs only', () => {
    const config = parseAnalyticsConfig({
      NEXT_PUBLIC_TERMLY_WEBSITE_UUID: ' 0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0 ',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABC123XYZ',
      NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY: 'essential',
    });
    expect(config).toEqual({
      termlyWebsiteUuid: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', gaMeasurementId: 'G-ABC123XYZ', vercelCategory: 'essential',
    });
    expect(parseAnalyticsConfig({ NEXT_PUBLIC_TERMLY_WEBSITE_UUID: 'x"><script>', NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'UA-1-1' }))
      .toMatchObject({ termlyWebsiteUuid: null, gaMeasurementId: null });
    expect(parseAnalyticsConfig({ NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY: 'anything' }).vercelCategory).toBe('analytics');
  });

  it('builds the script addresses', () => {
    expect(termlyScriptUrl('abc')).toBe('https://app.termly.io/resource-blocker/abc?autoBlock=off');
    expect(gtagScriptUrl('G-ABC123')).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123');
  });
});
