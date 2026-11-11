/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accountDisplayName, membershipText } from './account-presentation';

describe('account presentation', () => {
  it('shows membership only from real profile data', () => {
    expect(membershipText({ data: { membership_level: 'free' } })).toBe('免费版');
    expect(membershipText({ data: { membership_level: 'pro' } })).toBe('会员账户');
    expect(membershipText({ data: { membership_level: 'free' } }, '基础套餐', '会员账户')).toBe('基础套餐');
  });

  it('never claims a membership level when the profile is missing', () => {
    expect(membershipText({ isError: true })).toBe('账户信息读取失败');
    expect(membershipText({})).toBe('');
  });

  it('returns no display name instead of a generic placeholder', () => {
    expect(accountDisplayName({ data: { nickname: '小王' } })).toBe('小王');
    expect(accountDisplayName({ data: { nickname: '', email: 'a@example.com' } })).toBe('a');
    expect(accountDisplayName({ isError: true })).toBeNull();
  });

  // Walkthrough 2026-11-11, item 14: a phone sign-up without a name showed the server's made-up "user-" + 8 id characters.
  it('shows a phone account that never picked a name by the last four digits of its number', () => {
    expect(accountDisplayName({ data: { nickname: 'user-0a1b2c3d', phone_masked: '138****5678' } })).toBe('手机尾号 5678');
    expect(accountDisplayName({ data: { nickname: '', phone_masked: '138****5678' } })).toBe('手机尾号 5678');
  });

  it('keeps a name the user chose, and a made-up name when there is no phone number to show instead', () => {
    expect(accountDisplayName({ data: { nickname: '小王', phone_masked: '138****5678' } })).toBe('小王');
    expect(accountDisplayName({ data: { nickname: 'user-experience', phone_masked: '138****5678' } })).toBe('user-experience');
    expect(accountDisplayName({ data: { nickname: 'user-0a1b2c3d', phone_masked: '' } })).toBe('user-0a1b2c3d');
    expect(accountDisplayName({ data: { nickname: 'user-0a1b2c3d' } })).toBe('user-0a1b2c3d');
  });

  it('the rail and its account popover show the same name and the same free label as the home page', () => {
    const frame = readFileSync(fileURLToPath(new URL('../components/opc/workspace-frame.tsx', import.meta.url)), 'utf8');
    expect(frame).toContain('const shownName=accountDisplayName(profile);');
    expect(frame).not.toContain('profile.data?.nickname??');
    expect(frame).not.toContain('普通会员');
  });
});
