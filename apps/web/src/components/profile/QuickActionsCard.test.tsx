import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The old card read check-in status through tRPC; keep the mock so a regression renders instead of crashing.
vi.mock('@/trpc/client', () => {
  const query = () => ({ data: { hasCheckedInToday: false, nextRewardCredits: 5, currentCycleDay: 1, cycleRewards: { 1: 5 } }, isLoading: false });
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({}),
      checkin: { getCheckinStatus: { useQuery: query }, claimDailyCheckin: { useMutation: mutation } },
    },
  };
});

import { QuickActionsCard } from './PersonalInfoCard';

describe('QuickActionsCard', () => {
  it('offers no daily check-in (removed 2026-10-26)', () => {
    const html = renderToStaticMarkup(<QuickActionsCard />);
    expect(html).toContain('账户安全');
    expect(html).toContain('提交工单');
    expect(html).not.toContain('签到');
    expect(html).not.toContain('profile-checkin-card');
  });
});
