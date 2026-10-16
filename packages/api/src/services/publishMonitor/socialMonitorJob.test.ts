/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runSocialMonitorJob } from './socialMonitorJob';
import type { ClientDeps } from './postForMe/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function db(switchValue: unknown, failing: string[] = []) {
  const calls: string[] = [];
  return { calls, db: {
    rpc: async (name: string) => {
      calls.push(name);
      if (failing.includes(name)) return { data: null, error: { message: 'x' } };
      if (name === 'publish_monitor_orphan_classify') return { data: { delete: [], unknownFormat: [], takenOver: [] }, error: null };
      return { data: [], error: null };
    },
    from: () => ({ select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: switchValue === undefined ? null : { value: switchValue }, error: null }) }),
  } as never };
}
const deps = (): ClientDeps => ({ apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
  fetchImpl: async () => json(200, { data: [], meta: { total: 0, offset: 0, limit: 100 } }) });

describe('publish-monitor daily job', () => {
  it('runs open publishes, deletions, attempts, then the sweep; deletion of orphans needs the switch to be exactly true', async () => {
    const off = db('true');
    const report = await runSocialMonitorJob(off.db, deps(), Date.now() + 60_000);
    expect(off.calls).toEqual(['publish_monitor_publish_reconcile_claim', 'publish_monitor_provider_work_claim', 'publish_monitor_cleanup_claim',
      'publish_monitor_orphan_classify']);
    expect([report.sweepDeleteEnabled, report.failures]).toEqual([false, []]);
    expect((await runSocialMonitorJob(db(true).db, deps(), Date.now() + 60_000)).sweepDeleteEnabled).toBe(true);
  });

  it('a failing step is reported and the following steps still run', async () => {
    const broken = db(undefined, ['publish_monitor_provider_work_claim']);
    const report = await runSocialMonitorJob(broken.db, deps(), Date.now() + 60_000);
    expect(report.failures).toEqual(['provider_work']);
    const publishes = db(undefined, ['publish_monitor_publish_reconcile_claim']);
    const second = await runSocialMonitorJob(publishes.db, deps(), Date.now() + 60_000);
    expect(second.failures).toEqual(['publishes']);
    expect(publishes.calls).toContain('publish_monitor_provider_work_claim');
    expect(broken.calls).toContain('publish_monitor_cleanup_claim');
  });
});
