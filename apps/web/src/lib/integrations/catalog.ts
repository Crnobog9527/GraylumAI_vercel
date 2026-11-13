/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * INTEGRATION-SHOTVIVA PR C: the products shown on the integrations page (Owner 2026-11-12: every product built around
 * Graylum — image, video, digital-human, audio sites — gets its own module: what it does, when to use it, and a
 * link that takes the user there, tracked). A module is configuration only; the page renders whatever is listed here.
 * Shotviva is the only one so far; the others are added here once the Owner gives their names and links.
 *
 * Wording: Shotviva's confirmed by the Owner on 2026-11-13; no amounts, prices or quotas of our own.
 */
/** One of a product's own sample pictures (public/integrations/<id>/, 4:5, encoded at twice the size it is shown at). */
export type IntegrationPicture = { src: string; alt: string };
/** A sample picture with the few words under it. */
export type IntegrationSample = IntegrationPicture & { label: string };
/** One kind of use: a photo as it was taken and what came of it, its name and one short line. `cutout`: the result has no background. */
export type IntegrationUse = { label: string; note: string; before: IntegrationPicture; after: IntegrationPicture; cutout?: boolean };

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
   * 的，这样最直观"): a photo as it was taken and what a template made of it, and the same two for each kind of use.
   */
  showcase?: { before: IntegrationSample; after: IntegrationSample; uses: readonly IntegrationUse[] };
  /** What connecting it changes inside Graylum (absent: a link only, nothing to connect). */
  inGraylum?: readonly string[];
  /** The product's own page (Chinese). Tracking is added by trackedLink, never written here. */
  viewUrl: string;
  /** The connector behind it, when Graylum can connect to it. */
  connector?: 'shotviva';
};

/** A photo and what came of it, as the large view shows them: what the two are about, and each side with its name. */
export type IntegrationPair = { title: string; note: string; cutout: boolean;
  sides: readonly [IntegrationSample, IntegrationSample] };

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
    // 需要商品图、菜品图或房源图的时候。" (the pictures of 什么时候适合用). The other lines are as they were.
    features: [
      '每个模板都保留你拍的主体，只换光线、场景或画风。',
      '用付费积分生成的图是私密的，没有水印；用免费积分做的图会公开展示，并带水印。',
    ],
    whenToUse: [
      '一次上新很多商品，想用同一个模板整批出图的时候。',
      '想在 Graylum 写内容的同时，直接把配图也做出来的时候。',
    ],
    // Shotviva's own examples, each a photo as taken and what Shotviva made of it (Owner 2026-11-13, third look: "案例照片不要用
    // 鞋子这一张，差异化不太大", and which cases to show). From its repository: public/cases and public/home (the pictures of its
    // /zh pages), and for the two templates 咖啡夜色吧台 and 西餐苔藓森林 the photo and the result its template cards show. The
    // short lines are cut from the sentences Shotviva's pages say about each; what a poster in a picture says (a date, a
    // discount) is the picture's, and is not repeated in words here.
    showcase: {
      before: { src: '/integrations/shotviva/coffee-phone.webp', label: '手机拍的照片',
        alt: '真实手机照：咖啡店石纹台面上的一杯橙片冰咖啡，身后是咖啡机、磨豆机和杯架' },
      after: { src: '/integrations/shotviva/coffee-noir-bar.webp', label: '选一个模板后',
        alt: '真实案例：同一杯咖啡放在深色吧台上，一束暖光打在冰块和杯壁上，旁边是橙子和咖啡豆' },
      uses: [
        { label: '菜品图', note: '出菜口用手机拍一张，光线和造型交给模板',
          before: { src: '/integrations/shotviva/salad-phone.webp', alt: '真实手机照：后厨不锈钢台面上的一盘鸡肉凯撒沙拉' },
          after: { src: '/integrations/shotviva/salad-forest-moss.webp', alt: '真实案例：同一盘凯撒沙拉，四周是青苔、蕨叶、火山石和树皮' } },
        { label: '商品图', note: '随手拍的包做成促销海报，还是同一只包',
          before: { src: '/integrations/shotviva/tote-phone.webp', alt: '手机随手拍：厨房台面上的一只编织皮托特包，窗边自然光（真实案例）' },
          after: { src: '/integrations/shotviva/tote-promo.webp', alt: '同一只包做成新品促销海报，明亮影棚光（真实案例）' } },
        { label: '房源图', note: '同一个客厅、同一个角度，杂物都收掉了',
          before: { src: '/integrations/shotviva/room-phone.webp',
            alt: '真实手机照：傍晚的大平层客厅，布艺沙发、洞石茶几和整面城市落地窗，地上有购物袋、快递箱和扫地机器人' },
          after: { src: '/integrations/shotviva/room-staged.webp',
            alt: '真实案例：同一个大平层客厅、同一个角度，杂物都收掉了，傍晚的金色光线，茶几上一瓶白色枝条' } },
        { label: '一键白底图', note: '去掉衣架和门，放到纯白底上',
          before: { src: '/integrations/shotviva/dress-phone.webp', alt: '真实手机照：一条象牙白民族风绣花分层长裙挂在卧室门上，旁边是床和脏衣篮' },
          after: { src: '/integrations/shotviva/dress-white.webp', alt: '真实案例：同一条绣花长裙，纯白背景' } },
        { label: '一键抠图', note: '街景和行人都去掉，发丝一根根保留', cutout: true,
          before: { src: '/integrations/shotviva/hair-phone.webp',
            alt: '真实手机照：穿驼色大衣的模特站在黄昏的街头，逆光下头发被风吹起，身后有灯架和摩托车' },
          after: { src: '/integrations/shotviva/hair-cutout.webp', alt: '真实案例：同一位模特抠成透明底，每一缕飞起的发丝都保留' } },
        { label: '精准编辑图片文字', note: '写一句话改字，字体不变，照片和版式没动',
          before: { src: '/integrations/shotviva/poster-before.webp', alt: '真实案例：「青岚茶事」茶饮店海报，大字写着新店开业，下面是两杯水果冰茶' },
          after: { src: '/integrations/shotviva/poster-after.webp', alt: '真实案例：同一张海报，大字改成了一周年店庆，字体没变' } },
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

/**
 * A sample picture's large version, for looking at it closely (Owner 2026-11-13: "要支持用户点击以后看大图"): the same picture
 * exported again from the product's own file, 960×1200 where the file allows, kept beside the small ones under large/.
 */
export const largePicture = (src: string): string => src.replace(/\/([^/]+)$/, '/large/$1');

/** What a module's pictures open into, in the order they stand on the page: 能做什么's two, then the two of each kind of use. */
export function showcasePairs(module: IntegrationModule): IntegrationPair[] {
  const { showcase } = module;
  if (!showcase) return [];
  return [{ title: '能做什么', note: module.features[0] ?? '', cutout: false, sides: [showcase.before, showcase.after] },
    ...showcase.uses.map(use => ({ title: use.label, note: use.note, cutout: !!use.cutout,
      sides: [{ ...use.before, label: '原图' }, { ...use.after, label: '成品' }] as const }))];
}

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
