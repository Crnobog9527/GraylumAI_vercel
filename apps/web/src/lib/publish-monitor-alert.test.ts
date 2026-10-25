/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
import { reportPublishMonitorQuota } from './publish-monitor-alert';
import { scrubErrorEvent } from './sentry-scrub';

beforeEach(() => vi.resetAllMocks());
const usage = { configured: true, limit: 1000, used: 850, reserved: 10 };

it('stays quiet while the plan has room, or has not been configured', () => {
  reportPublishMonitorQuota(usage, 'ok');
  reportPublishMonitorQuota({ configured: false }, 'full');
  expect(sentry.captureMessage).not.toHaveBeenCalled();
});

it('raises one fixed code per level with only the three counts', () => {
  reportPublishMonitorQuota(usage, 'near');
  expect(sentry.captureMessage).toHaveBeenLastCalledWith('PUBLISH_MONITOR_QUOTA_NEAR', {
    level: 'warning', fingerprint: ['PUBLISH_MONITOR_QUOTA_NEAR'],
    tags: { category: 'publish_monitor', code: 'PUBLISH_MONITOR_QUOTA_NEAR' }, extra: { limit: 1000, used: 850, reserved: 10 } });
  reportPublishMonitorQuota({ ...usage, used: 995, reserved: 5 }, 'full');
  expect(sentry.captureMessage).toHaveBeenLastCalledWith('PUBLISH_MONITOR_QUOTA_FULL', expect.objectContaining({ level: 'fatal',
    fingerprint: ['PUBLISH_MONITOR_QUOTA_FULL'] }));
});

it('the Sentry scrubber keeps exactly those integers for these codes and drops anything else', () => {
  const event = { message: 'PUBLISH_MONITOR_QUOTA_NEAR', extra: { limit: 1000, used: 850, reserved: 10, note: 'x', email: 'a@b.c' } };
  const out = scrubErrorEvent(event as never);
  expect(out.extra).toEqual({ limit: 1000, used: 850, reserved: 10 });
  expect(out.fingerprint).toEqual(['PUBLISH_MONITOR_QUOTA_NEAR']);
});
