/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { LOGIN_HREF, SIMPLIFIED_HOME_HREF } from '@/components/public-site/site-chrome';
import { ONE_LINE_DEFINITION } from '@/lib/seo/site';

/**
 * Sample J's full header and footer (the controller's plan of 2026-10-15, round six; the Owner has not confirmed it
 * yet). Labels are NEW unless marked. Pages that do not exist yet link to their planned address and are listed in
 * `J_PENDING_PAGES`, so the PR can name them; this sample does not build them.
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

const RESOURCES: ChromeLink[] = [
  { label: '博客', href: PLANNED.blog },
  { label: '教程', href: '/tutorials' },
  { label: '常见问题', href: '/faq' },
];

export const J_NAV = {
  label: '主导航',
  product: { label: '产品', links: PRODUCT },
  samples: { label: '样例报告', href: PLANNED.samples },
  pricing: { label: '价格', href: '/landing/pricing' },
  resources: { label: '资源', links: RESOURCES },
  about: { label: '关于我们', href: '/about' },
  languages: [
    { label: '简体', href: SIMPLIFIED_HOME_HREF, lang: 'zh-Hans', current: true },
    { label: '繁體', href: '/zh-tw', lang: 'zh-TW', current: false },
  ],
  languageLabel: '语言',
  login: { label: '登录', href: LOGIN_HREF },
  menu: '菜单',
  close: '关闭菜单',
} as const;

export const J_FOOTER = {
  label: '页脚',
  columns: [
    { title: '产品', links: [
      { label: '功能介绍', href: PLANNED.features },
      { label: '样例报告', href: PLANNED.samples },
      { label: '评审团', href: PLANNED.jury },
      { label: '价格', href: '/landing/pricing' },
    ] },
    { title: '资源', links: [...RESOURCES, { label: '自媒體', href: '/zh-tw' }] },
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

/** Pages the header and footer link to that do not exist yet (for the PR's "待建页面" list). */
export const J_PENDING_PAGES = [
  PLANNED.features, PLANNED.positioning, PLANNED.content, PLANNED.jury, PLANNED.library, PLANNED.publish, PLANNED.review,
  PLANNED.samples, PLANNED.blog, PLANNED.refund, PLANNED.cookies,
] as const;
