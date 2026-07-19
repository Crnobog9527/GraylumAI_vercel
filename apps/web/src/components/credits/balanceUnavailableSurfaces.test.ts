import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('unavailable balance surface wiring', () => {
  it('keeps AppHeader subscription links and recharge warnings inside the ready branch', () => {
    const source = readSource('../layout/AppHeader.tsx');

    expect(source).toContain("creditsStatus === 'ready' ?");
    expect(source).toContain('href="/profile?tab=subscription"');
    expect(source).toContain('积分余额暂不可用，请稍后重试');
    expect(source).toContain('getCreditsAvailabilityLabel(creditsStatus)');
  });

  it('uses credits.getBalance state as Profile canonical balance without profile fallback', () => {
    const source = readSource('../../app/profile/page.tsx');

    expect(source).toContain('useCreditsBalance()');
    expect(source).toContain("creditsStatus === 'ready' && credits !== null ? credits : undefined");
    expect(source).not.toContain('creditsBalance?.credits ??');
    expect(source).not.toContain('userProfile as any)?.credits');
    expect(source).toContain('积分余额暂不可用');
    expect(source).toContain('重试');
  });

  it('hides balance-triggered package CTAs from unavailable Profile surfaces', () => {
    const overviewSource = readSource('../profile/PersonalInfoCard.tsx');
    const subscriptionSource = readSource('../profile/SubscriptionCard.tsx');

    expect(overviewSource).toContain('hasVerifiedBalance &&');
    expect(overviewSource).toContain('购买加油包');
    expect(subscriptionSource).toContain('hasVerifiedBalance &&');
    expect(subscriptionSource).toContain('<CreditPackagesSection');
  });
});
