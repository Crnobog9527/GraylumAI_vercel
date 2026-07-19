import { describe, expect, it } from 'vitest';
import { formatCreditsBalance, getCreditsAvailabilityLabel } from './balancePresentation';

describe('balance presentation', () => {
  it('shows a real zero only when balance is ready', () => {
    expect(formatCreditsBalance('ready', 0)).toBe('0');
  });

  it('shows no false zero or recharge semantics when balance is unavailable', () => {
    const presentation = [
      formatCreditsBalance('unavailable', null),
      getCreditsAvailabilityLabel('unavailable'),
    ].join(' ');

    expect(presentation).toBe('-- 暂不可用');
    expect(presentation).not.toMatch(/\b0\b|已用完|积分不足|充值|购买/);
  });
});
