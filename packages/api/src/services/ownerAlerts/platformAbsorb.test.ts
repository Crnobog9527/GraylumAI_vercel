/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { createDedupe, type MarkStore } from './dedupe';
import type { NotifyDeps } from './notify';
import { ABSORB_MESSAGES_PER_RUN, checkPlatformAbsorbWith } from './platformAbsorb';

const clock = { t: Date.parse('2026-11-08T10:05:00Z') };
function deps(config: NotifyDeps['config'] = { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: 's' }) {
  const marks = new Map<string, number>();
  const store: MarkStore = {
    async setIfAbsent(key, _v, ttl) { if ((marks.get(key) ?? 0) > clock.t) return false; marks.set(key, clock.t + ttl * 1000); return true; },
    async remove(key) { marks.delete(key); },
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 0 })));
  const value: NotifyDeps = { config, dedupe: createDedupe(() => store, () => clock.t), feishu: { fetch: fetch as never, now: () => clock.t },
    origin: 'https://www.graylum.com', testSite: false, now: () => new Date(clock.t) };
  return { deps: value, fetch };
}
const alert = (model: string, utcDate = '2026-11-08') => ({ model, utcDate, nominalEquivalentUsd: '12.300000000000', thresholdUsd: '10' });
const report = (alerts: ReturnType<typeof alert>[]) => vi.fn(async () => ({ status: 'enabled', alerts }) as never);

describe('checkPlatformAbsorbWith', () => {
  it('reads the admin report at most once an hour and sends each model and day once', async () => {
    const { deps: d, fetch } = deps();
    const read = report([alert('m1'), alert('m2')]);
    expect(await checkPlatformAbsorbWith({} as never, d, read)).toBe(2);
    expect(await checkPlatformAbsorbWith({} as never, d, read)).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
    const start = clock.t;
    clock.t = start + 3600_000;
    expect(await checkPlatformAbsorbWith({} as never, d, read)).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).content.text)
      .toContain('模型 m1 由平台承担的成本约 $12.30，超过了提醒线 $10.00');
    clock.t = start;
  });

  it(`sends at most ${ABSORB_MESSAGES_PER_RUN} a run`, async () => {
    const { deps: d, fetch } = deps();
    clock.t += 7200_000;
    await checkPlatformAbsorbWith({} as never, d, report(Array.from({ length: 8 }, (_, i) => alert(`m${i}`))));
    expect(fetch).toHaveBeenCalledTimes(ABSORB_MESSAGES_PER_RUN);
  });

  it('does no read at all when Feishu is not configured, or the setting is off', async () => {
    const read = report([alert('m1')]);
    expect(await checkPlatformAbsorbWith({} as never, deps(null).deps, read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    const off = vi.fn(async () => ({ status: 'disabled', alerts: [] }) as never);
    clock.t += 7200_000;
    expect(await checkPlatformAbsorbWith({} as never, deps().deps, off)).toBe(0);
  });
});
