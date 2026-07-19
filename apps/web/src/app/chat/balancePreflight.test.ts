import { describe, expect, it, vi } from 'vitest';
import { CHAT_BALANCE_UNAVAILABLE_PRESENTATION, runChatBalancePreflight } from './balancePreflight';

describe('runChatBalancePreflight', () => {
  it('uses retry-only unavailable copy without recharge semantics', () => {
    const copy = Object.values(CHAT_BALANCE_UNAVAILABLE_PRESENTATION).join(' ');

    expect(copy).toContain('余额暂时无法验证');
    expect(copy).toContain('重试');
    expect(copy).not.toMatch(/积分已用完|积分不足|充值|购买/);
  });

  it('ignores an old positive cache when the current refetch fails', async () => {
    let input = '请保留这段输入';
    const stream = vi.fn(async () => {
      input = '';
    });

    const decision = await runChatBalancePreflight({
      cachedCredits: 500,
      refetchBalance: async () => { throw new Error('network unavailable'); },
      resolveFreeTierEnabled: async () => false,
      onReady: stream,
    });

    expect(decision).toEqual({ status: 'unavailable' });
    expect(stream).not.toHaveBeenCalled();
    expect(input).toBe('请保留这段输入');
  });

  it('does not stream when the refetch returns unavailable', async () => {
    const stream = vi.fn();

    const decision = await runChatBalancePreflight({
      cachedCredits: null,
      refetchBalance: async () => ({
        status: 'unavailable',
        credits: null,
        creditsExpiringSoon: null,
        creditsExpiryDate: null,
        warningLevel: null,
      }),
      resolveFreeTierEnabled: async () => false,
      onReady: stream,
    });

    expect(decision.status).toBe('unavailable');
    expect(stream).not.toHaveBeenCalled();
  });

  it('preserves the real-zero block when free tier is unavailable', async () => {
    const stream = vi.fn();

    const decision = await runChatBalancePreflight({
      cachedCredits: 0,
      refetchBalance: async () => ({
        status: 'ready',
        credits: 0,
        creditsExpiringSoon: 0,
        creditsExpiryDate: null,
        warningLevel: 'empty',
      }),
      resolveFreeTierEnabled: async () => false,
      onReady: stream,
    });

    expect(decision).toEqual({ status: 'blocked_zero', credits: 0, warningLevel: 'empty' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('preserves free-tier sending for a freshly verified real-zero balance', async () => {
    const stream = vi.fn();

    const decision = await runChatBalancePreflight({
      cachedCredits: 0,
      refetchBalance: async () => ({
        status: 'ready',
        credits: 0,
        creditsExpiringSoon: 0,
        creditsExpiryDate: null,
        warningLevel: 'empty',
      }),
      resolveFreeTierEnabled: async () => true,
      onReady: stream,
    });

    expect(decision).toEqual({ status: 'ready', credits: 0, warningLevel: 'empty' });
    expect(stream).toHaveBeenCalledOnce();
  });

  it('allows a freshly verified positive balance to enter the stream preflight', async () => {
    const stream = vi.fn();
    const resolveFreeTierEnabled = vi.fn(async () => {
      throw new Error('settings unavailable');
    });

    const decision = await runChatBalancePreflight({
      cachedCredits: null,
      refetchBalance: async () => ({
        status: 'ready',
        credits: 100,
        creditsExpiringSoon: 0,
        creditsExpiryDate: null,
        warningLevel: 'none',
      }),
      resolveFreeTierEnabled,
      onReady: stream,
    });

    expect(decision.status).toBe('ready');
    expect(stream).toHaveBeenCalledOnce();
    expect(resolveFreeTierEnabled).not.toHaveBeenCalled();
  });

  it('fails closed when a real-zero balance cannot resolve free tier availability', async () => {
    const stream = vi.fn();

    const decision = await runChatBalancePreflight({
      cachedCredits: 0,
      refetchBalance: async () => ({
        status: 'ready',
        credits: 0,
        creditsExpiringSoon: 0,
        creditsExpiryDate: null,
        warningLevel: 'empty',
      }),
      resolveFreeTierEnabled: async () => {
        throw new Error('settings unavailable');
      },
      onReady: stream,
    });

    expect(decision).toEqual({ status: 'unavailable' });
    expect(stream).not.toHaveBeenCalled();
  });
});
