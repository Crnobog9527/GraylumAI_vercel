/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { LOGIN_HREF, SIMPLIFIED_HOME_HREF } from '@/components/public-site/site-chrome';
import { ONE_LINE_DEFINITION } from '@/lib/seo/site';

/**
 * Sample J's full header and footer, as the Owner set them on 2026-10-15 (replacing the controller's first plan).
 * Labels are the Owner's; the menu notes are NEW. Pages that do not exist yet link to their planned address and are
 * listed in `J_PENDING_PAGES`, so the PR can name them; this sample does not build them. "教程" is the blog (Owner:
 * "就是博客"; SEO_GEO_SPEC section 14 approved /blog). The old /tutorials page (four generic cards from 2026-03) is
 * not linked any more.
 */
export type ChromeLink = { label: string; href: string; note?: string };

/** Planned addresses (not built yet). The sample reports follow samplePath's /landing/samples/<group>. */
const PLANNED = {
  features: '/features',
  positioning: '/features/positioning',
  content: '/features/content',
  jury: '/features/jury',
  library: '/features/library',
  publish: '/features/publish',
  review: '/features/review',
  samples: '/landing/samples',
  blog: '/blog',
  refund: '/refund',
  /** Cookie settings open Termly's preference window once Termly is in (Owner 2026-10-13); until then, the policy. */
  cookies: '/privacy#cookies',
} as const;

const PRODUCT: ChromeLink[] = [
  { label: '定位分析', href: PLANNED.positioning, note: '先弄清做什么、给谁看、靠什么赚钱' },
  { label: '选题与创作', href: PLANNED.content, note: '每周排好选题，按你的文风写稿' },
  { label: '评审团', href: PLANNED.jury, note: '几位评审各审一遍，写出修订稿' },
  { label: '资料库', href: PLANNED.library, note: '定位和资料都记着，换窗口也不忘' },
  { label: '发布排期', href: PLANNED.publish, note: '标题标签按平台改好，排进日历' },
  { label: '数据复盘', href: PLANNED.review, note: '读真实数据，告诉你下周怎么调' },
];

const TUTORIALS: ChromeLink = { label: '教程', href: PLANNED.blog };
const FAQ: ChromeLink = { label: '常见问题', href: '/faq' };

export const J_NAV = {
  label: '主导航',
  product: { label: '产品', links: PRODUCT },
  places: [TUTORIALS, { label: '价格', href: '/landing/pricing' }, FAQ, { label: '关于我们', href: '/about' }],
  /**
   * OWNER (2026-10-15): one globe button with the current language's short name, opening a menu of full names.
   * English has no pages yet: SEO_GEO_SPEC forbids links and hreflang to /en before it is live, so it shows, unlinked.
   */
  languages: [
    { label: '简体中文', short: '简体', href: SIMPLIFIED_HOME_HREF, lang: 'zh-Hans', current: true },
    { label: '繁體中文', short: '繁體', href: '/zh-tw', lang: 'zh-TW', current: false },
    { label: 'English', short: 'English', href: null, lang: 'en', current: false },
  ],
  soon: '即将推出',
  languageLabel: '语言',
  login: { label: '登录', href: LOGIN_HREF },
  /** OWNER (2026-10-15): the header's button only; the first screen and the close keep "免费和教练聊聊". */
  cta: '免费试用',
  menu: '菜单',
  close: '关闭菜单',
} as const;

export const J_FOOTER = {
  label: '页脚',
  columns: [
    { title: '产品', links: [
      { label: '功能介绍', href: PLANNED.features },
      { label: '评审团', href: PLANNED.jury },
      { label: '价格', href: '/landing/pricing' },
    ] },
    /**
     * No link to the sample reports yet (2026-10-17): /landing/samples is not built (it was a 404 on staging), and the
     * people in them are fictional, so they must never be called 用户案例 (Owner 2026-10-17).
     */
    { title: '资源', links: [TUTORIALS, FAQ] },
    { title: '公司', links: [
      { label: '关于我们', href: '/about' },
      { label: '联系我们', href: '/contact' },
    ] },
    { title: '法律', links: [
      { label: '服务条款', href: '/terms' },
      { label: '隐私政策', href: '/privacy' },
      { label: '可接受使用政策', href: '/acceptable-use' },
      { label: '退款政策', href: PLANNED.refund },
      { label: 'Cookie 设置', href: PLANNED.cookies },
    ] },
  ],
  /** FINAL: the site-wide one-line definition (SEO_GEO_SPEC, lib/seo/site.ts). */
  definition: ONE_LINE_DEFINITION['zh-Hans'],
  rights: '© 2026 Grayscale Luminary LLC',
} as const;

/**
 * Pages the header and footer link to that do not exist yet (for the PR's "待建页面" list); /en is not linked at all.
 * /features, its six pages and /blog came with PR #1090 (2026-10-18).
 */
export const J_PENDING_PAGES = [PLANNED.samples, PLANNED.refund, PLANNED.cookies] as const;

/**
 * Whether a header or footer link leads to a page that exists. The production home page (sample L on /landing, Owner
 * 2026-10-17) links only those; a link comes back by itself once its page is built and taken off J_PENDING_PAGES.
 * Cookie settings point into the privacy page, which exists, until Termly's button replaces them.
 */
export function linkReady(href: string) {
  return href === PLANNED.cookies || !(J_PENDING_PAGES as readonly string[]).includes(href);
}
