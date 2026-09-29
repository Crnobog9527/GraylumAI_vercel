// 个人中心的分页。链接到某个分页时用 profileTabHref，避免写出不存在的 tab。
export const PROFILE_TABS = ['profile', 'subscription', 'credits', 'history', 'security', 'tickets'] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number];

export function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return typeof value === 'string' && (PROFILE_TABS as readonly string[]).includes(value);
}

export function profileTabHref(tab: ProfileTab): string {
  return tab === 'profile' ? '/profile' : `/profile?tab=${tab}`;
}

// 切换分页时只改 tab 参数，保留地址里的其它参数（例如支付回跳的 checkout）。
export function withProfileTab(currentHref: string, tab: ProfileTab): string {
  const url = new URL(currentHref);
  if (tab === 'profile') {
    url.searchParams.delete('tab');
  } else {
    url.searchParams.set('tab', tab);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
