/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticsService } from './diagnostics';

function createService(value: unknown = null, error: unknown = null) {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const single = vi.fn().mockResolvedValue({ data: value === null ? null : { value }, error });
  const client = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single })) })),
      insert,
    })),
  } as unknown as SupabaseClient;
  return { service: new DiagnosticsService({ supabase: client, supabaseAdmin: client }), insert };
}

describe('diagnostic report verification limits', () => {
  it('does not report a local limiter probe as verified request-path enforcement', async () => {
    const { service, insert } = createService();
    const result = await service.runSingleTest('security_ratelimit');
    expect(result?.status).toBe('warning');
    expect(result?.message).toContain('未验证请求链路限流');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'warning' }));
  });

  it.each([
    ['missing settings', null, null],
    ['enabled setting', { circuitBreakerEnabled: true, maxCreditsPerHour: 500 }, null],
    ['disabled setting', { circuitBreakerEnabled: false }, null],
    ['query failure', null, { message: 'unavailable' }],
  ])('does not infer working circuit-breaker enforcement from %s', async (_label, value, error) => {
    const { service, insert } = createService(value, error);
    const result = await service.runSingleTest('security_circuit_breaker');
    expect(result?.status).toBe('warning');
    expect(result?.message).toContain('未验证消费熔断');
    expect(result?.message).not.toContain('已启用');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'warning' }));
  });
});
