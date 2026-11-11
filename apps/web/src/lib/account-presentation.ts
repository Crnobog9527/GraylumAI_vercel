interface ProfileQueryLike {
  data?: { nickname?: string | null; email?: string | null; membership_level?: string | null; phone_masked?: string | null } | null;
  isError?: boolean;
}

// 会员等级只在真正读到资料后显示；读取中不显示文字（页面不出现“读取中”），失败时显示中性提示，不用默认等级冒充。
// 免费档叫"免费版"，和价格页的"免费"是同一个说法（走查 2026-11-11 第 14 条；原来叫"普通会员"）。
export function membershipText(profile: ProfileQueryLike, freeLabel = '免费版', paidLabel = '会员账户'): string {
  if (profile.data) return profile.data.membership_level === 'free' ? freeLabel : paidLabel;
  return profile.isError ? '账户信息读取失败' : '';
}

const GENERATED_NAME = /^user-[0-9a-f]{8}$/;

// 没读到资料时返回 null，由页面决定不显示名字，而不是显示"用户"。
export function accountDisplayName(profile: ProfileQueryLike): string | null {
  const data = profile.data;
  if (!data) return null;
  // 手机号注册、还没起名的账号：服务端会给一个 "user-" 加 8 位编号的名字（packages/api/src/trpc.ts），
  // 这里显示成"手机尾号 5678"，数据库里的昵称不变。用户自己起过名的不受影响。
  const phoneTail = /(\d{4})$/.exec(data.phone_masked ?? '')?.[1];
  if (phoneTail && (!data.nickname || GENERATED_NAME.test(data.nickname))) return `手机尾号 ${phoneTail}`;
  return data.nickname || data.email?.split('@')[0] || null;
}
