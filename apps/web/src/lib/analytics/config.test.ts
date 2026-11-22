import { describe, expect, it } from 'vitest';
import { gtagScriptUrl, parseAnalyticsConfig } from './config';

describe('analytics config', () => {
  it('stays off when nothing is configured', () => {
    expect(parseAnalyticsConfig({})).toEqual({ pvuvSite: null, gaMeasurementId: null, vercelCategory: 'analytics' });
  });

  it('reads valid values', () => {
    expect(parseAnalyticsConfig({
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABC123XYZ',
      NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY: 'essential',
      NEXT_PUBLIC_PVUV_SITE: 'site_abc123',
    })).toEqual({ pvuvSite: 'site_abc123', gaMeasurementId: 'G-ABC123XYZ', vercelCategory: 'essential' });
  });

  it('drops malformed values, and no longer reads the Termly website id (ANALYTICS-CONSENT)', () => {
    const config = parseAnalyticsConfig({
      NEXT_PUBLIC_TERMLY_WEBSITE_UUID: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'UA-1-1',
    });
    expect(config).toEqual({ pvuvSite: null, gaMeasurementId: null, vercelCategory: 'analytics' });
  });

  it('drops a malformed pvuv site id', () => {
    expect(parseAnalyticsConfig({ NEXT_PUBLIC_PVUV_SITE: 'a b<script>' }).pvuvSite).toBeNull();
    expect(parseAnalyticsConfig({ NEXT_PUBLIC_PVUV_SITE: '  ' }).pvuvSite).toBeNull();
  });

  it('builds the gtag.js address', () => {
    expect(gtagScriptUrl('G-ABC123XYZ')).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ');
  });
});
