/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runSocialMonitorJob, runSocialMonitorRetention } from './socialMonitorJob';
import type { ClientDeps } from './postForMe/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function db(switchValue: unknown, failing: string[] = [], featureOn: boolean | 'unreadable' = false) {
  const calls: string[] = [];
  return { calls, db: {
    rpc: async (name: string) => {
      calls.push(name);
      if (failing.includes(name)) return { data: null, error: { message: 'x' } };
      if (name === 'publish_monitor_orphan_classify') return { data: { delete: [], unknownFormat: [], takenOver: [] }, error: null };
      if (name === 'publish_monitor_snapshot_prune' || name === 'publish_monitor_billed_prune') return { data: 0, error: null };
      if (name === 'publish_monitor_stuck_list') return { data: { connections: [], requests: [] }, error: null };
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
    expect(off.calls).toEqual(['publish_monitor_snapshot_prune', 'publish_monitor_billed_prune', 'publish_monitor_publish_reconcile_claim',
      'publish_monitor_billed_orphans',
      'publish_monitor_provider_work_claim', 'publish_monitor_cleanup_claim', 'publish_monitor_orphan_classify',
      'publish_monitor_stuck_list']);
    expect([report.sweepDeleteEnabled, report.refresh, report.failures, report.stuck])
      .toEqual([false, null, [], { connections: 0, requests: 0 }]);
    expect((await runSocialMonitorJob(db(true).db, deps(), Date.now() + 60_000, windowFor)).sweepDeleteEnabled).toBe(true);
  });

  it('reads data only while the feature switch is on, after cleanup and before the sweep', async () => {
    const on = db(undefined, [], true);
    const report = await runSocialMonitorJob(on.db, deps(), Date.now() + 60_000, windowFor);
    expect(on.calls).toEqual(['publish_monitor_snapshot_prune', 'publish_monitor_billed_prune', 'publish_monitor_publish_reconcile_claim',
      'publish_monitor_billed_orphans',
      'publish_monitor_provider_work_claim', 'publish_monitor_cleanup_claim', 'publish_monitor_refresh_claim',
      'publish_monitor_orphan_classify', 'publish_monitor_stuck_list']);
    expect(report.refresh).toEqual({ claimed: 0, outcomes: {} });
  });

  it('an unreadable feature switch is a reported refresh failure, not a silent skip', async () => {
    const broken = db(undefined, [], 'unreadable');
    expect((await runSocialMonitorJob(broken.db, deps(), Date.now() + 60_000, windowFor)).failures).toEqual(['refresh']);
  });

  it('without a Post for Me key, retention, held credits and TikHub still run; Post for Me steps are skipped', async () => {
    const none = db(undefined, [], true);
    const report = await runSocialMonitorJob(none.db, null, Date.now() + 60_000, windowFor, Date.now,
      { env: {}, entitlement: async () => ({ windowDays: 30, benchmark: true }) });
    expect(none.calls).toContain('publish_monitor_billed_orphans');
    expect(none.calls).toContain('publish_monitor_tikhub_claim');
    expect(none.calls.some(n => n.startsWith('publish_monitor_provider_work') || n === 'publish_monitor_refresh_claim')).toBe(false);
    expect([report.postForMe, report.failures]).toEqual([false, []]);
  });

  it('held billed runs are closed even while the feature switch is off', async () => {
    const off = db(undefined, [], false);
    await runSocialMonitorJob(off.db, deps(), Date.now() + 60_000, windowFor, Date.now,
      { env: {}, entitlement: async () => ({ windowDays: 30, benchmark: true }) });
    expect(off.calls).toContain('publish_monitor_billed_orphans');
    expect(off.calls).not.toContain('publish_monitor_tikhub_claim');
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

  it('counts stopped cleanup last, even after a failing step, and reports a failed count as a failure', async () => {
    const stuck = db(undefined, ['publish_monitor_cleanup_claim']);
    const report = await runSocialMonitorJob(stuck.db, deps(), Date.now() + 60_000, windowFor);
    expect([report.failures, report.stuck, stuck.calls.at(-1)])
      .toEqual([['attempts'], { connections: 0, requests: 0 }, 'publish_monitor_stuck_list']);
    const unreadable = await runSocialMonitorJob(db(undefined, ['publish_monitor_stuck_list']).db, deps(), Date.now() + 60_000, windowFor);
    expect([unreadable.failures, unreadable.stuck]).toEqual([['stuck'], null]);
  });

  it('without a provider key, expired publish claims are still released (database only, no check work handed out)',
    async () => {
      const calls: Array<[string, unknown]> = [];
      const noKey = { rpc: async (name: string, args: unknown) => {
        calls.push([name, args]);
        return { data: ['publish_monitor_snapshot_prune', 'publish_monitor_billed_prune'].includes(name) ? 0 : [], error: null };
      } } as never;
      const result = await runSocialMonitorRetention(noKey, Date.now() + 60_000);
      expect(result.publishes).toMatchObject({ processed: 0 });
      expect(calls.find(([name]) => name === 'publish_monitor_publish_reconcile_claim')?.[1])
        .toMatchObject({ p_release_only: true });
    });
});
