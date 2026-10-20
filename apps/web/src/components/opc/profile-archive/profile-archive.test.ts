/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { isDraftArchived, isProfileArchivedError, PROFILE_ARCHIVE_TEXT, profileName, splitProfiles } from './profile-archive';
import { gateAdmissionNotice } from '@/lib/runtime-gate-notice';

const businesses = [
  { businessId: 'a', name: '账号 A', archivedAt: null, isArchived: false, drafts: [{ draftId: 'a-old' }, { draftId: 'a-new' }] },
  { businessId: 'b', name: ' ', archivedAt: '2026-10-19T00:00:00Z', isArchived: true, drafts: [] },
  { businessId: 'c', name: '账号 C', archivedAt: '2026-10-20T00:00:00Z', isArchived: true, drafts: [{ draftId: 'c-1' }] },
];
const drafts = [
  { draftId: 'a-old', createdAt: '2026-10-01' },
  { draftId: 'a-new', createdAt: '2026-10-05' },
  { draftId: 'c-1', createdAt: '2026-10-02' },
  { draftId: 'orphan', createdAt: '2026-10-09' },
];

describe('profile archive helpers', () => {
  it('splits active and archived profiles, each opening its newest draft', () => {
    const { active, archived } = splitProfiles(businesses, drafts);
    expect(active.map(row => [row.businessId, row.draftId])).toEqual([['a', 'a-new']]);
    // Most recently archived first; a profile with no draft has nothing to open.
    expect(archived.map(row => [row.businessId, row.draftId])).toEqual([['c', 'c-1'], ['b', null]]);
    expect(splitProfiles(undefined, undefined)).toEqual({ active: [], archived: [] });
    // Without the drafts list the profile still opens one of its own drafts.
    expect(splitProfiles(businesses, undefined).active[0]?.draftId).toBe('a-old');
  });

  it('names an unnamed profile', () => {
    expect(profileName({ name: ' ' })).toBe(PROFILE_ARCHIVE_TEXT.unnamed);
    expect(profileName({ name: null })).toBe(PROFILE_ARCHIVE_TEXT.unnamed);
    expect(profileName({ name: '账号 A' })).toBe('账号 A');
  });

  it('treats a draft as archived only when an archived profile lists it', () => {
    expect(isDraftArchived(businesses, 'c-1')).toBe(true);
    expect(isDraftArchived(businesses, 'a-new')).toBe(false);
    expect(isDraftArchived(businesses, 'orphan')).toBe(false);
    expect(isDraftArchived(undefined, 'c-1')).toBe(false);
  });

  it('recognises the server refusal by message or code', () => {
    expect(isProfileArchivedError(new Error('OPC_BUSINESS_ARCHIVED'))).toBe(true);
    expect(isProfileArchivedError(Object.assign(new Error('refused'), { code: 'OPC_BUSINESS_ARCHIVED' }))).toBe(true);
    expect(isProfileArchivedError(new Error('OPC_PROFILE_LIMIT'))).toBe(false);
    expect(isProfileArchivedError('OPC_BUSINESS_ARCHIVED')).toBe(false);
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
