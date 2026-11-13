/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * INTEGRATION-SHOTVIVA PR C: the products shown on the integrations page (Owner 2026-11-12: every product built around
 * Graylum — image, video, digital-human, audio sites — gets its own module: what it does, when to use or buy it, and a
 * link that takes the user there, tracked). A module is configuration only; the page renders whatever is listed here.
 * Shotviva is the only one so far; the others are added here once the Owner gives their names and links.
 *
 * Wording: only what the product already says about itself (Shotviva: src/site/messages/zh.json), no numbers or promises
 * of our own. Pending the Owner's confirmation (listed in the PR).
 */
export type IntegrationModule = {
  id: string;
  name: string;
  /** One line under the name. */
  tagline: string;
  /** What it does, in a few short lines. */
  features: readonly string[];
  /** When it is worth using or buying. */
  whenToUse: readonly string[];
  /** What connecting it changes inside Graylum (absent: a link only, nothing to connect). */
  inGraylum?: readonly string[];
  /** The product's own pages (Chinese). Tracking is added by trackedLink, never written here. */
  viewUrl: string;
  buyUrl: string;
  /** The connector behind it, when Graylum can connect to it. */
  connector?: 'shotviva';
};

export const INTEGRATIONS: readonly IntegrationModule[] = [
  {
    id: 'shotviva',
    name: 'Shotviva',
    tagline: '保留真实照片细节，AI 一键出大片',
    features: [
      '每个模板都保留你拍的主体，只换光线、场景或画风。',
      '商品图、美食图、宠物照等模板，选一个就能出图。',
      '用付费积分生成的图是私密的，没有水印；用免费积分做的图会公开展示，并带水印。',
    ],
    whenToUse: [
      '开店、做餐饮、做民宿或做内容，需要商品图、菜品图或房源图的时候。',
      '一次上新很多商品，想用同一个模板整批出图的时候。',
      '想在 Graylum 写内容的同时，直接把配图也做出来的时候。',
    ],
    inGraylum: [
      '连接后，在 Graylum 的对话里配图，直接用你的 Shotviva 积分生成，Graylum 不另外收费。',
      'Graylum 只拿到你的 Shotviva 账号 ID 和剩余积分，拿不到密码，也拿不到别的信息。',
      '随时可以在这里断开，也可以在 Shotviva 的账号页里断开。',
    ],
    viewUrl: 'https://shotviva.com/zh',
    buyUrl: 'https://shotviva.com/zh/pricing',
    connector: 'shotviva',
  },
];

/** A module's link with the source marked (controller 2026-11-12: Shotviva's partner marker from=graylum, plus utm_* which
 * Shotviva's analytics keeps; not ?ref=, which is the affiliate commission and would be an internal settlement). */
export function trackedLink(url: string, moduleId: string, kind: 'view' | 'buy'): string {
  const target = new URL(url);
  target.searchParams.set('from', 'graylum');
  target.searchParams.set('utm_source', 'graylum');
  target.searchParams.set('utm_medium', 'integration');
  target.searchParams.set('utm_campaign', moduleId);
  target.searchParams.set('utm_content', kind);
  return target.toString();
}

/** What the page says after Shotviva's redirect back (callback route: ?shotviva=connected or ?shotviva_error=CODE). */
const CONNECT_MESSAGES: Record<string, string> = {
  connected: '已连接 Shotviva。现在可以在对话里直接配图了。',
  SHOTVIVA_STATE_INVALID: '这次连接没有完成：页面已过期，或是在另一个账号里发起的。请重新点「连接」。',
  SHOTVIVA_CODE_INVALID: '这次连接没有完成：授权已过期或已经用过。请重新点「连接」。',
  SHOTVIVA_MEMBERSHIP_REQUIRED: '连接 Shotviva 是 Pro 和 Gold 会员的功能。',
  SHOTVIVA_ACCOUNT_CLOSED: '当前账号不能连接 Shotviva。',
  SHOTVIVA_BUSY: '操作太频繁了，请稍等一会儿再试。',
  SHOTVIVA_UNAVAILABLE: 'Shotviva 暂时连接不上，请稍后再试。',
  LOGIN_REQUIRED: '登录已过期，请重新登录后再连接。',
};
export function connectMessage(params: { connected?: string | null; error?: string | null }):
  { tone: 'success' | 'error'; text: string } | null {
  if (params.connected === 'connected') return { tone: 'success', text: CONNECT_MESSAGES.connected! };
  if (!params.error) return null;
  return { tone: 'error', text: CONNECT_MESSAGES[params.error] ?? CONNECT_MESSAGES.SHOTVIVA_UNAVAILABLE! };
}
