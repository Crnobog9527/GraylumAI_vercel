import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ next: (): Promise<unknown> => Promise.resolve(null), calls: 0 }));
vi.mock('../membershipEntitlements', () => ({ readOwnDataTier: () => { m.calls += 1; return m.next(); } }));
import { memberLevelDenied } from './memberOnly';

const admin = {} as never;
const as = (level: string) => { m.next = () => Promise.resolve({ level, ownDataWindowDays: 0, allowBenchmarkMonitor: false }); };
beforeEach(() => { m.calls = 0; });

it('a module with no requirement reads no plan and denies nobody', async () => {
  expect(await memberLevelDenied(admin, 'a', null)).toBe(false);
  expect(await memberLevelDenied(admin, 'a', undefined)).toBe(false);
  expect(m.calls).toBe(0);
});
it('refuses a plan below the requirement and allows one at or above it', async () => {
  as('free'); expect(await memberLevelDenied(admin, 'a', 'pro')).toBe(true);
  as('pro'); expect(await memberLevelDenied(admin, 'a', 'pro')).toBe(false);
  as('pro'); expect(await memberLevelDenied(admin, 'a', 'gold')).toBe(true);
  as('gold'); expect(await memberLevelDenied(admin, 'a', 'gold')).toBe(false);
});
it('refuses when the plan cannot be read', async () => {
  m.next = () => Promise.reject(new Error('down'));
  expect(await memberLevelDenied(admin, 'a', 'pro')).toBe(true);
});
