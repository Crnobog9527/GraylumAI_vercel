import { describe, expect, it } from 'vitest';
import { gtagScriptUrl, parseAnalyticsConfig } from './config';

describe('analytics config', () => {
  it('stays off when nothing is configured', () => {
    expect(parseAnalyticsConfig({})).toEqual({ gaMeasurementId: null, vercelCategory: 'analytics' });
  });

  it('reads valid values', () => {
    expect(parseAnalyticsConfig({
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'G-ABC123XYZ',
      NEXT_PUBLIC_VERCEL_ANALYTICS_CATEGORY: 'essential',
    })).toEqual({ gaMeasurementId: 'G-ABC123XYZ', vercelCategory: 'essential' });
  });

  it('drops malformed values, and no longer reads the Termly website id (ANALYTICS-CONSENT)', () => {
    const config = parseAnalyticsConfig({
      NEXT_PUBLIC_TERMLY_WEBSITE_UUID: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0',
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: 'UA-1-1',
    });
    expect(config).toEqual({ gaMeasurementId: null, vercelCategory: 'analytics' });
  });

  it('builds the gtag.js address', () => {
    expect(gtagScriptUrl('G-ABC123XYZ')).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ');
  });
});
