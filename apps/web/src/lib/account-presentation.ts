interface ProfileQueryLike {
  data?: { nickname?: string | null; email?: string | null; membership_level?: string | null } | null;
  isError?: boolean;
}

// 会员等级只在真正读到资料后显示；读取中或失败时显示中性状态，不用默认等级冒充。
export function membershipText(profile: ProfileQueryLike, freeLabel = '普通会员', paidLabel = '会员账户'): string {
  if (profile.data) return profile.data.membership_level === 'free' ? freeLabel : paidLabel;
  return profile.isError ? '账户信息读取失败' : '正在读取账户…';
}

// 没读到资料时返回 null，由页面决定不显示名字，而不是显示"用户"。
export function accountDisplayName(profile: ProfileQueryLike): string | null {
  const data = profile.data;
  if (!data) return null;
  return data.nickname || data.email?.split('@')[0] || null;
}
