/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the member-side PAY-FOUNDER UI. Status always comes from the server (founder.me).

export type FounderState = 'none' | 'active' | 'grace' | 'frozen' | 'ended';

export interface FounderMemberView {
  founder: { state: FounderState; deadline: string | null; endedReason: 'refunded' | 'lapsed' | 'expired' | null };
  consent: { currentVersion: string; granted: boolean };
  entry: {
    displayName: string; socialAccounts: { platform: string; handle: string; url: string }[];
    productName: string | null; productUrl: string | null; intro: string | null;
    reviewState: 'pending' | 'approved' | 'rejected'; updatedAt?: string;
  } | null;
  listed: boolean;
  community: { url: string | null; note: string | null } | null;
}

/** The wording version the consent text on the form carries; it must equal the server's current version. */
export const FOUNDER_WALL_COPY_VERSION = 'fw-v1';

export const CONSENT_TEXT = '我同意 Graylum 在公开的创始会员展示墙上展示以上内容（展示名、社媒账号、产品和介绍）。'
  + '内容经审核通过后才会显示；我可以随时撤回，撤回后立即从展示墙下架。';

export const PLATFORMS: { value: string; label: string }[] = [
  { value: 'douyin', label: '抖音' }, { value: 'xiaohongshu', label: '小红书' }, { value: 'wechat_channels', label: '视频号' },
  { value: 'bilibili', label: 'B 站' }, { value: 'weibo', label: '微博' }, { value: 'kuaishou', label: '快手' },
  { value: 'youtube', label: 'YouTube' }, { value: 'tiktok', label: 'TikTok' }, { value: 'instagram', label: 'Instagram' },
  { value: 'x', label: 'X' }, { value: 'facebook', label: 'Facebook' }, { value: 'linkedin', label: 'LinkedIn' },
  { value: 'other', label: '其他' },
];

/** The badge shows only while the identity is in force: active or grace. Frozen is hidden but not ended. */
export function showsBadge(state: FounderState | undefined) {
  return state === 'active' || state === 'grace';
}

/** The personal-center card appears for members, and for ended members who still have a card to explain. */
export function showsCard(view: FounderMemberView | undefined) {
  if (!view) return false;
  const { state } = view.founder;
  return state === 'active' || state === 'grace' || state === 'frozen' || (state === 'ended' && view.entry !== null);
}

export function canEditCard(state: FounderState) {
  return state === 'active' || state === 'grace';
}

export function statusLine(view: FounderMemberView) {
  switch (view.founder.state) {
    case 'active': return '你的创始会员身份有效。';
    case 'grace': return '你的创始会员身份在宽限期内，请在期限前续上，徽章和展示照常保留。';
    case 'frozen': return '你的账号有一笔付款正在处理中，徽章和展示墙卡片暂时撤下；处理结束后会自动恢复，社群不受影响。';
    case 'ended': return '你的创始会员身份已结束，徽章和展示墙卡片已下架。';
    default: return '';
  }
}

export function wallStatus(view: FounderMemberView) {
  const { entry } = view;
  if (!entry) return null;
  if (!canEditCard(view.founder.state)) return '卡片已下架';
  if (!view.consent.granted) return '已撤回公开，卡片未展示';
  if (entry.reviewState === 'pending') return '待审核：通过后才会出现在展示墙上';
  if (entry.reviewState === 'rejected') return '未通过审核：修改内容后可重新提交';
  return view.listed ? '已展示在创始会员墙上' : '已通过审核，暂未展示';
}

export interface FormValue {
  displayName: string;
  accounts: { platform: string; handle: string; url: string }[];
  productName: string;
  productUrl: string;
  intro: string;
  consent: boolean;
}

export const EMPTY_FORM: FormValue = {
  displayName: '', accounts: [{ platform: 'douyin', handle: '', url: '' }], productName: '', productUrl: '', intro: '', consent: false,
};

export function formFromEntry(view: FounderMemberView): FormValue {
  const entry = view.entry;
  if (!entry) return EMPTY_FORM;
  return {
    displayName: entry.displayName,
    accounts: entry.socialAccounts.length ? entry.socialAccounts.map(item => ({ ...item })) : EMPTY_FORM.accounts,
    productName: entry.productName ?? '', productUrl: entry.productUrl ?? '', intro: entry.intro ?? '',
    // Never pre-ticked: the member opts in again for each submission.
    consent: false,
  };
}

/** Builds the submit payload, or the first problem to show. Empty account rows are dropped. */
export function buildSubmit(form: FormValue): { error: string } | { entry: Record<string, unknown>; consentVersion: string } {
  if (!form.consent) return { error: '请先勾选“愿意公开”，我们才会展示你的卡片。' };
  if (!form.displayName.trim()) return { error: '请填写展示名。' };
  const accounts = form.accounts.filter(item => item.handle.trim() || item.url.trim());
  if (accounts.some(item => !item.handle.trim() || !item.url.trim())) return { error: '每个社媒账号都要填写账号名和主页链接。' };
  if (form.productUrl.trim() && !form.productName.trim()) return { error: '填写了产品链接，请同时填写产品名。' };
  return {
    consentVersion: FOUNDER_WALL_COPY_VERSION,
    entry: {
      displayName: form.displayName.trim(),
      socialAccounts: accounts.map(item => ({ platform: item.platform, handle: item.handle.trim(), url: item.url.trim() })),
      productName: form.productName.trim() || null, productUrl: form.productUrl.trim() || null,
      intro: form.intro.trim() || null,
    },
  };
}

const ERRORS: [string, string][] = [
  ['FOUNDER_WALL_LINK_INVALID', '链接必须是 https:// 开头的外部地址，且不能带用户名或密码。'],
  ['FOUNDER_WALL_VERSION_STALE', '同意说明已更新，请刷新页面后重新提交。'],
  ['FOUNDER_WALL_NOT_FOUNDER', '只有有效或宽限期内的创始会员可以提交展示卡。'],
  ['FOUNDER_ACCOUNT_CLOSED', '账号正在注销，不能提交展示卡。'],
  ['FOUNDER_WALL_ENTRY_MISSING', '没有找到你的展示卡。'],
  ['FOUNDER_WALL_PRODUCT_NAME_REQUIRED', '填写了产品链接，请同时填写产品名。'],
  ['FOUNDER_TEXT_INVALID', '内容不能为空，也不能含控制字符。'],
  ['FOUNDER_WALL_INPUT_INVALID', '内容不符合要求，请检查字数和格式。'],
];

export function founderMemberError(error: { message?: string } | null | undefined) {
  const hit = ERRORS.find(([code]) => error?.message?.includes(code));
  return hit ? hit[1] : '保存失败，请稍后重试；结果可能已生效，请先刷新确认。';
}
