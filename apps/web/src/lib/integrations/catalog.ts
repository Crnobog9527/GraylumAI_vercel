/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * INTEGRATION-SHOTVIVA PR C: the products shown on the integrations page (Owner 2026-11-12: every product built around
 * Graylum — image, video, digital-human, audio sites — gets its own module: what it does, when to use it, and a
 * link that takes the user there, tracked). A module is configuration only; the page renders whatever is listed here.
 * Shotviva is the only one so far; the others are added here once the Owner gives their names and links.
 *
 * Wording: Shotviva's confirmed by the Owner on 2026-11-13; no amounts, prices or quotas of our own.
 */
/** One of a product's own sample pictures (public/integrations/<id>/), with the few words under it. */
export type IntegrationSample = { src: string; alt: string; label: string; note?: string };

export type IntegrationModule = {
  id: string;
  name: string;
  /** The product's own mark, a square picture under public/integrations (absent: a plain picture icon). */
  icon?: string;
  /** One line under the name. */
  tagline: string;
  /** The product's belief, under the one line (absent: none). */
  philosophy?: string;
  /** What it does, in a few short lines (with `showcase`: the first is the line under its two pictures). */
  features: readonly string[];
  /** When it is worth using, in a few short lines (with `showcase`: under the pictures of its uses). */
  whenToUse: readonly string[];
  /**
   * The product's own sample pictures, which say most of the introduction (Owner 2026-11-13: "文字太多了…最好能配点样例图之类
   * 的，这样最直观"): a photo as it was taken and what a template made of it, and one picture for each kind of use.
   */
  showcase?: { before: IntegrationSample; after: IntegrationSample; uses: readonly IntegrationSample[] };
  /** What connecting it changes inside Graylum (absent: a link only, nothing to connect). */
  inGraylum?: readonly string[];
  /** The product's own page (Chinese). Tracking is added by trackedLink, never written here. */
  viewUrl: string;
  /** The connector behind it, when Graylum can connect to it. */
  connector?: 'shotviva';
};

export const INTEGRATIONS: readonly IntegrationModule[] = [
  {
    id: 'shotviva',
    name: 'Shotviva',
    // Owner 2026-11-13: Shotviva's own icon (their 512px file, kept here at 192px).
    icon: '/integrations/shotviva.png',
    // Owner 2026-11-13 ("文案可以，就按这版改"): the one line, the belief and inGraylum's second line, word for word.
    tagline: 'Shotviva 是一款为普通人和小商家打造的 AI 照片工作室：用手机拍下的真实照片，选一个模板，三步就能做出能直接用的商品图、菜品图和宣传图。',
    philosophy: '我们相信，好看的照片不该只属于会写提示词、会用专业软件的人。Shotviva 保留你拍下的真实主体，只帮你换光线、场景和风格；不用写任何提示词，先看到效果再动手。',
    // Owner 2026-11-13 (second look): pictures first, fewer words. Two of the earlier lines are now said by the pictures and the
    // words under them: "商品图、美食图、宠物照等模板，选一个就能出图。" (the two pictures of 能做什么) and "开店、做餐饮、做民宿或做内容，
    // 需要商品图、菜品图或房源图的时候。" (the three pictures of 什么时候适合用). The other lines are as they were.
    features: [
      '每个模板都保留你拍的主体，只换光线、场景或画风。',
      '用付费积分生成的图是私密的，没有水印；用免费积分做的图会公开展示，并带水印。',
    ],
    whenToUse: [
      '一次上新很多商品，想用同一个模板整批出图的时候。',
      '想在 Graylum 写内容的同时，直接把配图也做出来的时候。',
    ],
    // Shotviva's own published examples (its repository's public/cases, the pictures of its /zh pages), at 480×600; the
    // descriptions are the ones Shotviva's pages give them.
    showcase: {
      before: { src: '/integrations/shotviva/sneaker-phone.webp', label: '手机拍的照片',
        alt: '真实手机照：玄关木地板上的一只米白色皮面运动鞋，后跟是灰绿色麂皮，早晨阳光很硬，钥匙和打开的鞋盒都入镜了' },
      after: { src: '/integrations/shotviva/sneaker-lifestyle.webp', label: '选一个模板后',
        alt: '真实案例：同一只鞋放在阳光下咖啡馆门口的水泥台阶上，身后是虚化的亚麻外套' },
      uses: [
        { src: '/integrations/shotviva/sneaker-listing.webp', label: '商品图', note: '开店',
          alt: '真实案例：同一只鞋的纯白底商品主图，柔和影棚光' },
        { src: '/integrations/shotviva/menu-fish-dark.webp', label: '菜品图', note: '做餐饮',
          alt: '真实案例：同一份酸菜鱼重新装进白瓷碗，放在深色原木上，暖色侧光，热气升起' },
        { src: '/integrations/shotviva/room-staged.webp', label: '房源图', note: '做民宿',
          alt: '真实案例：同一个大平层客厅、同一个角度，杂物都收掉了，傍晚的金色光线，茶几上一瓶白色枝条' },
      ],
    },
    inGraylum: [
      '连接后，在 Graylum 的对话里配图，直接用你的 Shotviva 积分生成，Graylum 不另外收费。',
      'Graylum 只保存你的 Shotviva 账号 ID；在对话里配图时，会把你的出图要求发给 Shotviva 生成。Graylum 拿不到你的 Shotviva 密码。',
      '随时可以在这里断开，也可以在 Shotviva 的账号页里断开。',
    ],
    viewUrl: 'https://shotviva.com/zh',
    connector: 'shotviva',
  },
];

/** A module's link with the source marked (controller 2026-11-12: Shotviva's partner marker from=graylum, plus utm_* which
 * Shotviva's analytics keeps; not ?ref=, which is the affiliate commission and would be an internal settlement). The one link
 * a module has is 去查看 (Owner 2026-11-13: "只保留'去查看'"), so utm_content is always view. */
export function trackedLink(url: string, moduleId: string): string {
  const target = new URL(url);
  target.searchParams.set('from', 'graylum');
  target.searchParams.set('utm_source', 'graylum');
  target.searchParams.set('utm_medium', 'integration');
  target.searchParams.set('utm_campaign', moduleId);
  target.searchParams.set('utm_content', 'view');
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
