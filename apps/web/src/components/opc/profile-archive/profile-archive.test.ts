/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { isArchivedBusiness, isProfileArchivedError, PROFILE_ARCHIVE_TEXT, profileName, splitProfiles } from './profile-archive';
import { readBusinesses } from './profile-archive-api';
import { gateAdmissionNotice } from '@/lib/runtime-gate-notice';

const businesses = [
  { businessId: 'a', name: '账号 A', archivedAt: null, isArchived: false },
  { businessId: 'b', name: ' ', archivedAt: '2026-10-19T00:00:00Z', isArchived: true },
  { businessId: 'c', name: '账号 C', archivedAt: '2026-10-20T00:00:00Z', isArchived: true },
];
const drafts = [
  { draftId: 'a-old', businessId: 'a', createdAt: '2026-10-01' },
  { draftId: 'a-new', businessId: 'a', createdAt: '2026-10-05' },
  { draftId: 'c-1', businessId: 'c', createdAt: '2026-10-02' },
  { draftId: 'orphan', businessId: null, createdAt: '2026-10-09' },
];

describe('profile archive helpers', () => {
  it('splits active and archived profiles, each opening its newest draft', () => {
    const { active, archived } = splitProfiles(businesses, drafts);
    expect(active.map(row => [row.businessId, row.draftId])).toEqual([['a', 'a-new']]);
    // Most recently archived first; a profile with no draft has nothing to open.
    expect(archived.map(row => [row.businessId, row.draftId])).toEqual([['c', 'c-1'], ['b', null]]);
    expect(splitProfiles(undefined, undefined)).toEqual({ active: [], archived: [] });
  });

  it('names an unnamed profile', () => {
    expect(profileName({ name: ' ' })).toBe(PROFILE_ARCHIVE_TEXT.unnamed);
    expect(profileName({ name: null })).toBe(PROFILE_ARCHIVE_TEXT.unnamed);
    expect(profileName({ name: '账号 A' })).toBe('账号 A');
  });

  it('treats a draft as archived only when its profile is known to be archived', () => {
    expect(isArchivedBusiness(businesses, 'c')).toBe(true);
    expect(isArchivedBusiness(businesses, 'a')).toBe(false);
    expect(isArchivedBusiness(undefined, 'c')).toBe(false);
    expect(isArchivedBusiness(businesses, null)).toBe(false);
  });

  it('recognises the server refusal by message or code', () => {
    expect(isProfileArchivedError(new Error('OPC_BUSINESS_ARCHIVED'))).toBe(true);
    expect(isProfileArchivedError(Object.assign(new Error('refused'), { code: 'OPC_BUSINESS_ARCHIVED' }))).toBe(true);
    expect(isProfileArchivedError(new Error('OPC_PROFILE_LIMIT'))).toBe(false);
    expect(isProfileArchivedError('OPC_BUSINESS_ARCHIVED')).toBe(false);
  });

  it('reads either response shape and drops rows that are not profiles', () => {
    expect(readBusinesses(businesses)).toHaveLength(3);
    expect(readBusinesses({ businesses: [businesses[0], { businessId: 'x' }, null] })).toEqual([businesses[0]]);
    expect(readBusinesses(null)).toEqual([]);
  });

  it('shows the friendly notice for an archived refusal on any admission path', () => {
    const cause = Object.assign(new Error('OPC_BUSINESS_ARCHIVED'), { data: { code: 'FORBIDDEN', path: 'other.path' } });
    expect(gateAdmissionNotice(cause, ['opc.mentorTurnStream'])).toBe(PROFILE_ARCHIVE_TEXT.archivedRefusal);
    expect(PROFILE_ARCHIVE_TEXT.archivedRefusal).not.toMatch(/积分|OPC_/);
  });

  it('says what archiving does before it is confirmed', () => {
    expect(PROFILE_ARCHIVE_TEXT.confirmBody).toContain('只能查看和导出');
    expect(PROFILE_ARCHIVE_TEXT.confirmBody).toContain('不能再继续对话或生成报告');
    expect(PROFILE_ARCHIVE_TEXT.confirmBody).toContain('释放 1 个名额');
    expect(PROFILE_ARCHIVE_TEXT.confirmBody).toContain('不能恢复');
  });
});
