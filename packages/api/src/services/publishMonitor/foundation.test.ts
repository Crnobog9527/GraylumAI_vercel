/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  assertPublishMonitorEnabled, listConnections, readPublishMonitorSettings, setAutoReview,
} from './foundation';

const actor = '00000000-0000-4000-8000-0000000a0001';
const business = '00000000-0000-4000-8000-0000000a0002';

function rpcReturning(data: unknown, error: { message: string } | null = null) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return { calls, db: {
    rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data, error }; },
  } as never };
}
function switchReturning(value: unknown, error: { message: string } | null = null) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: value === undefined
    ? null : { value }, error }) };
  return { from: () => chain } as never;
}

describe('publish-monitor foundation', () => {
  it('stays off unless the switch is exactly true', async () => {
    await expect(assertPublishMonitorEnabled(switchReturning(undefined))).rejects.toThrow('PUBLISH_MONITOR_DISABLED');
    await expect(assertPublishMonitorEnabled(switchReturning('true'))).rejects.toThrow('PUBLISH_MONITOR_DISABLED');
    await expect(assertPublishMonitorEnabled(switchReturning(true, { message: 'x' })))
      .rejects.toThrow('PUBLISH_MONITOR_UNAVAILABLE');
    await expect(assertPublishMonitorEnabled(switchReturning(true))).resolves.toBeUndefined();
  });

  it('reads and sets the automatic review switch for the authenticated profile only', async () => {
    const state = { autoReviewEnabled: false, autoReviewEnabledAt: '2026-10-13T00:00:00Z' };
    const read = rpcReturning(state);
    await expect(readPublishMonitorSettings(read.db, actor)).resolves.toEqual(state);
    expect(read.calls).toEqual([{ name: 'publish_monitor_settings', args: { a: actor } }]);
    const write = rpcReturning(state);
    await setAutoReview(write.db, actor, { enabled: false });
    expect(write.calls).toEqual([{ name: 'publish_monitor_set_auto_review', args: { a: actor, p_enabled: false } }]);
  });

  it('maps a closed account and rejects malformed or extra fields', async () => {
    await expect(setAutoReview(rpcReturning(null, { message: 'PUBLISH_MONITOR_ACCOUNT_CLOSED' }).db, actor,
      { enabled: true })).rejects.toThrow('PUBLISH_MONITOR_ACCOUNT_CLOSED');
    await expect(readPublishMonitorSettings(rpcReturning({ autoReviewEnabled: 'yes', autoReviewEnabledAt: null }).db,
      actor)).rejects.toThrow('PUBLISH_MONITOR_UNAVAILABLE');
    await expect(readPublishMonitorSettings(rpcReturning({ autoReviewEnabled: true, autoReviewEnabledAt: null,
      providerAccountId: 'leak' }).db, actor)).rejects.toThrow('PUBLISH_MONITOR_UNAVAILABLE');
    await expect(readPublishMonitorSettings(rpcReturning(null).db, 'not-a-uuid')).rejects.toThrow();
  });

  it('lists connections without server-only identifiers', async () => {
    const row = { id: actor, businessId: business, accountProjectId: null, role: 'benchmark', source: 'tikhub',
      platform: 'douyin', displayHint: null, status: 'connected', consentRead: true, consentAutoTrack: false,
      consentPublish: false, lastSuccessAt: null, postCount: 0 };
    await expect(listConnections(rpcReturning([row]).db, actor)).resolves.toEqual([row]);
    await expect(listConnections(rpcReturning([{ ...row, providerAccountId: 'x' }]).db, actor))
      .rejects.toThrow('PUBLISH_MONITOR_UNAVAILABLE');
    await expect(listConnections(rpcReturning([{ ...row, status: 'deleting' }]).db, actor))
      .rejects.toThrow('PUBLISH_MONITOR_UNAVAILABLE');
  });
});
