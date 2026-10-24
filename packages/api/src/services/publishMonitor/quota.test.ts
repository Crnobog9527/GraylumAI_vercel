/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { quotaLevel, readQuotaUsage } from './quota';

const rpc = (data: unknown, error: unknown = null) => ({ rpc: vi.fn().mockResolvedValue({ data, error }) }) as never;
const period = { configured: true as const, periodStart: '2026-10-13T00:00:00+00:00', periodEnd: '2026-11-13T00:00:00+00:00' };

describe('publish quota usage', () => {
  it('reads the period count and an unconfigured plan; anything else is refused', async () => {
    const ok = { ...period, limit: 1000, used: 12, reserved: 2 };
    await expect(readQuotaUsage(rpc(ok))).resolves.toEqual(ok);
    await expect(readQuotaUsage(rpc({ configured: false }))).resolves.toEqual({ configured: false });
    await expect(readQuotaUsage(rpc({ ...ok, used: -1 }))).rejects.toThrow('PUBLISH_MONITOR_QUOTA_UNAVAILABLE');
    await expect(readQuotaUsage(rpc({ ...ok, extra: 1 }))).rejects.toThrow('PUBLISH_MONITOR_QUOTA_UNAVAILABLE');
    await expect(readQuotaUsage(rpc(null, { message: 'x' }))).rejects.toThrow('PUBLISH_MONITOR_QUOTA_UNAVAILABLE');
  });

  it('warns from 80% and counts held slots like the claim does; full at the limit', () => {
    const at = (used: number, reserved: number) => quotaLevel({ ...period, limit: 1000, used, reserved });
    expect([at(0, 0), at(799, 0), at(790, 9)]).toEqual(['ok', 'ok', 'ok']);
    expect([at(800, 0), at(700, 100), at(999, 0)]).toEqual(['near', 'near', 'near']);
    expect([at(1000, 0), at(900, 100), at(990, 20)]).toEqual(['full', 'full', 'full']);
  });
});
