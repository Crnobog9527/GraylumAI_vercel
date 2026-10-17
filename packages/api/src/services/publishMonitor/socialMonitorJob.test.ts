/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runSocialMonitorJob } from './socialMonitorJob';
import type { ClientDeps } from './postForMe/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function db(switchValue: unknown, failing: string[] = [], featureOn: boolean | 'unreadable' = false) {
  const calls: string[] = [];
  return { calls, db: {
    rpc: async (name: string) => {
      calls.push(name);
      if (failing.includes(name)) return { data: null, error: { message: 'x' } };
      if (name === 'publish_monitor_orphan_classify') return { data: { delete: [], unknownFormat: [], takenOver: [] }, error: null };
      if (name === 'publish_monitor_snapshot_prune') return { data: 0, error: null };
      return { data: [], error: null };
    },
    from: () => {
      let key = '';
      return { select() { return this; }, eq(_: string, value: string) { key = value; return this; },
        maybeSingle: async () => {
          if (key === 'publish_monitor_enabled') {
            return featureOn === 'unreadable' ? { data: null, error: { message: 'x' } } : { data: { value: featureOn }, error: null };
          }
          if (key !== 'publish_monitor_orphan_sweep_delete') return { data: null, error: null };
          return { data: switchValue === undefined ? null : { value: switchValue }, error: null };
        } };
    },
  } as never };
}
const windowFor = async () => 30;
const deps = (): ClientDeps => ({ apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
  fetchImpl: async () => json(200, { data: [], meta: { total: 0, offset: 0, limit: 100 } }) });

describe('publish-monitor daily job', () => {
  it('runs retention, open publishes and deletions first, then attempts, then the sweep; deletion of orphans needs the switch to be exactly true', async () => {
    const off = db('true');
    const report = await runSocialMonitorJob(off.db, deps(), Date.now() + 60_000, windowFor);
    expect(off.calls).toEqual(['publish_monitor_snapshot_prune', 'publish_monitor_publish_reconcile_claim',
      'publish_monitor_provider_work_claim', 'publish_monitor_cleanup_claim', 'publish_monitor_orphan_classify']);
    expect([report.sweepDeleteEnabled, report.refresh, report.failures]).toEqual([false, null, []]);
    expect((await runSocialMonitorJob(db(true).db, deps(), Date.now() + 60_000, windowFor)).sweepDeleteEnabled).toBe(true);
  });

  it('reads data only while the feature switch is on, after cleanup and before the sweep', async () => {
    const on = db(undefined, [], true);
    const report = await runSocialMonitorJob(on.db, deps(), Date.now() + 60_000, windowFor);
    expect(on.calls).toEqual(['publish_monitor_snapshot_prune', 'publish_monitor_publish_reconcile_claim',
      'publish_monitor_provider_work_claim', 'publish_monitor_cleanup_claim', 'publish_monitor_refresh_claim',
      'publish_monitor_orphan_classify']);
    expect(report.refresh).toEqual({ claimed: 0, outcomes: {} });
  });

  it('an unreadable feature switch is a reported refresh failure, not a silent skip', async () => {
    const broken = db(undefined, [], 'unreadable');
    expect((await runSocialMonitorJob(broken.db, deps(), Date.now() + 60_000, windowFor)).failures).toEqual(['refresh']);
  });

  it('a failing step is reported and the following steps still run', async () => {
    const broken = db(undefined, ['publish_monitor_provider_work_claim']);
    const report = await runSocialMonitorJob(broken.db, deps(), Date.now() + 60_000, windowFor);
    expect(report.failures).toEqual(['provider_work']);
    const publishes = db(undefined, ['publish_monitor_publish_reconcile_claim']);
    const second = await runSocialMonitorJob(publishes.db, deps(), Date.now() + 60_000, windowFor);
    expect(second.failures).toEqual(['publishes']);
    expect(publishes.calls).toContain('publish_monitor_provider_work_claim');
    expect(broken.calls).toContain('publish_monitor_cleanup_claim');
  });
});
