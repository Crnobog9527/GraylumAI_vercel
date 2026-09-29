/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { accountDisplayName, membershipText } from './account-presentation';

describe('account presentation', () => {
  it('shows membership only from real profile data', () => {
    expect(membershipText({ data: { membership_level: 'free' } })).toBe('普通会员');
    expect(membershipText({ data: { membership_level: 'pro' } })).toBe('会员账户');
    expect(membershipText({ data: { membership_level: 'free' } }, '基础套餐', '会员账户')).toBe('基础套餐');
  });

  it('never claims a membership level when the profile is missing', () => {
    expect(membershipText({ isError: true })).toBe('账户信息读取失败');
    expect(membershipText({})).toBe('正在读取账户…');
  });

  it('returns no display name instead of a generic placeholder', () => {
    expect(accountDisplayName({ data: { nickname: '小王' } })).toBe('小王');
    expect(accountDisplayName({ data: { nickname: '', email: 'a@example.com' } })).toBe('a');
    expect(accountDisplayName({ isError: true })).toBeNull();
  });
});
