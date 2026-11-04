/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
// A plain function, not vi.fn: a spy's bookkeeping of a returned rejected promise would report it as unhandled.
const m = vi.hoisted(() => ({ next: (): Promise<unknown> => Promise.resolve(null), calls: 0 }));
vi.mock('../../membershipEntitlements', () => ({ readOwnDataTier: () => { m.calls += 1; return m.next(); } }));
import { COACH_SKILL_NAME, memberCatalog } from './coachGate';
import type { SkillCatalogEntry } from './skillCatalog';

const entry = (name: string) => ({ name, description: '', moduleId: '1'.repeat(8) + '-1111-4111-8111-111111111111', skillId: 's', packageId: 'p',
  revisionId: 'r', packageHash: 'h', resultBytes: 1 }) as unknown as SkillCatalogEntry;
const admin = {} as SupabaseClient;
beforeEach(() => { m.calls = 0; });

it('an account with an own-data window keeps the coach Skill', async () => {
  m.next = () => Promise.resolve({ level: 'pro', ownDataWindowDays: 30, allowBenchmarkMonitor: false });
  const list = [entry('other'), entry(COACH_SKILL_NAME)];
  expect(await memberCatalog(admin, 'a', list)).toEqual(list);
});
it('a free account (no window) and an account whose plan cannot be read do not see the coach Skill; other Skills stay', async () => {
  m.next = () => Promise.resolve({ level: 'free', ownDataWindowDays: 0, allowBenchmarkMonitor: false });
  expect((await memberCatalog(admin, 'a', [entry('other'), entry(COACH_SKILL_NAME)])).map(e => e.name)).toEqual(['other']);
  m.next = () => Promise.reject(new Error('down'));
  expect((await memberCatalog(admin, 'a', [entry(COACH_SKILL_NAME), entry('other')])).map(e => e.name)).toEqual(['other']);
});
it('a catalog without the coach Skill reads no plan at all', async () => {
  const list = [entry('other')];
  expect(await memberCatalog(admin, 'a', list)).toBe(list);
  expect(m.calls).toBe(0);
});
it('the name is matched without case or edge spaces, and a plan lookup that throws a TRPC-style error still hides it', async () => {
  m.next = () => Promise.reject(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }));
  expect(await memberCatalog(admin, 'a', [entry(' Review-Coach '), entry('other')])).toHaveLength(1);
});

// MEMBER-ONLY-MODULES: the server drops a Skill from the catalog (so it is neither listed nor loadable) for a plan below its requirement.
const limited = (name: string, requiredMemberLevel: 'pro' | 'gold' | null) =>
  ({ ...entry(name), ...(requiredMemberLevel ? { requiredMemberLevel } : {}) }) as SkillCatalogEntry;
const tier = (level: string) => () => Promise.resolve({ level, ownDataWindowDays: level === 'free' ? 0 : 30, allowBenchmarkMonitor: false });
const names = async (level: string, list: SkillCatalogEntry[]) => (await memberCatalog(admin, 'a', list, tier(level) as never)).map(e => e.name);
it('a Pro account loads a Pro-only Skill; a free account does not; a Skill with no requirement is for everyone', async () => {
  const list = [limited('pro-only', 'pro'), limited('open', null)];
  expect(await names('pro', list)).toEqual(['pro-only', 'open']);
  expect(await names('gold', list)).toEqual(['pro-only', 'open']);
  expect(await names('free', list)).toEqual(['open']);
});
it('a Pro account is refused a Gold-only Skill; a Gold account loads it', async () => {
  const list = [limited('gold-only', 'gold'), limited('open', null)];
  expect(await names('pro', list)).toEqual(['open']);
  expect(await names('gold', list)).toEqual(['gold-only', 'open']);
});
it('an unreadable plan hides every Skill that has a requirement and keeps the open ones', async () => {
  m.next = () => Promise.reject(new Error('down'));
  expect((await memberCatalog(admin, 'a', [limited('pro-only', 'pro'), limited('open', null)])).map(e => e.name)).toEqual(['open']);
});
