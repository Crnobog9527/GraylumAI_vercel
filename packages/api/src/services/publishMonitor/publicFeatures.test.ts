/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { NO_PUBLIC_FEATURES, readPublicFeatures } from './publicFeatures';

type Result = { data: unknown; error: unknown };
const db = (result: Result | (() => never)) => ({
  from: () => ({ select: () => ({ in: async () => (typeof result === 'function' ? result() : result) }) }),
}) as unknown as Parameters<typeof readPublicFeatures>[0];

describe('public publish-monitor features', () => {
  it('names own data only when the switch is exactly true, and the review only on top of it', async () => {
    expect(await readPublicFeatures(db({ data: [{ key: 'publish_monitor_enabled', value: true },
      { key: 'publish_monitor_review_enabled', value: true }], error: null }))).toEqual({ ownData: true, weeklyReview: true, publish: false });
    expect(await readPublicFeatures(db({ data: [{ key: 'publish_monitor_enabled', value: 'true' },
      { key: 'publish_monitor_review_enabled', value: true }], error: null }))).toEqual(NO_PUBLIC_FEATURES);
    expect(await readPublicFeatures(db({ data: [{ key: 'publish_monitor_review_enabled', value: true }], error: null })))
      .toEqual(NO_PUBLIC_FEATURES);
    expect(await readPublicFeatures(db({ data: [{ key: 'publish_monitor_enabled', value: true }], error: null })))
      .toEqual({ ownData: true, weeklyReview: false, publish: false });
  });
  it('names one-click publishing only when its own listing switch is on as well', async () => {
    expect(await readPublicFeatures(db({ data: [{ key: 'publish_monitor_enabled', value: true },
      { key: 'publish_monitor_publish_listed', value: true }], error: null })))
      .toEqual({ ownData: true, weeklyReview: false, publish: true });
    expect(await readPublicFeatures(db({ data: [{ key: 'publish_monitor_publish_listed', value: true }], error: null })))
      .toEqual(NO_PUBLIC_FEATURES);
  });
  it('shows nothing when the read fails', async () => {
    expect(await readPublicFeatures(db({ data: null, error: { message: 'boom' } }))).toEqual(NO_PUBLIC_FEATURES);
    expect(await readPublicFeatures(db(() => { throw new Error('network'); }))).toEqual(NO_PUBLIC_FEATURES);
  });
});
