/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { SiteLocale } from '@/lib/seo/site';

// Header and footer wording per language. Login and sign-up stay at the root (SEO_GEO_SPEC section 2);
// on the public host the proxy forwards them to the app.
export { SIGNUP_CTA_HREF as SIGNUP_HREF } from '@/lib/seo/content/shared';
export const LOGIN_HREF = '/login';

type Link = { label: string; href: string };

export type SiteChrome = {
  home: string;
  nav: Link[];
  login: string;
  signup: string;
  pagesTitle: string;
  companyTitle: string;
  company: Link[];
  legalTitle: string;
  legal: Link[];
  languageTitle: string;
  updatedLabel: string;
  authorLabel: string;
  aboutLabel: string;
  breadcrumbLabel: string;
  faqTitle: string;
  relatedTitle: string;
  rights: string;
};

const LEGAL_PATHS = { terms: '/terms', privacy: '/privacy', acceptableUse: '/acceptable-use' };

export const SITE_CHROME: Record<SiteLocale, SiteChrome> = {
  'zh-Hans': {
    home: '/',
    nav: [
      { label: '价格', href: '/landing/pricing' },
      { label: '关于我们', href: '/about' },
    ],
    login: '登录',
    signup: '免费开始诊断',
    pagesTitle: '内容',
    companyTitle: '公司',
    company: [
      { label: '关于我们', href: '/about' },
      { label: '联系我们', href: '/contact' },
      { label: '常见问题', href: '/faq' },
    ],
    legalTitle: '法律',
    legal: [
      { label: '服务条款', href: LEGAL_PATHS.terms },
      { label: '隐私政策', href: LEGAL_PATHS.privacy },
      { label: '使用协议', href: LEGAL_PATHS.acceptableUse },
    ],
    languageTitle: '语言',
    updatedLabel: '更新于',
    authorLabel: 'Graylum 编辑团队',
    aboutLabel: '关于我们',
    breadcrumbLabel: '当前位置',
    faqTitle: '常见问题',
    relatedTitle: '继续阅读',
    rights: '版权所有',
  },
  'zh-TW': {
    home: '/zh-tw',
    nav: [
      { label: '自媒體經營', href: '/zh-tw/zimeiti-jingying' },
      { label: 'IG 經營', href: '/zh-tw/ig-jingying' },
      { label: '關於我們', href: '/zh-tw/about' },
    ],
    login: '登入',
    signup: '免費開始診斷',
    pagesTitle: '自媒體經營指南',
    companyTitle: '公司',
    company: [
      { label: '關於我們', href: '/zh-tw/about' },
      { label: '聯絡我們（簡體）', href: '/contact' },
    ],
    legalTitle: '法律條款（簡體）',
    legal: [
      { label: '服務條款', href: LEGAL_PATHS.terms },
      { label: '隱私權政策', href: LEGAL_PATHS.privacy },
      { label: '使用規範', href: LEGAL_PATHS.acceptableUse },
    ],
    languageTitle: '語言',
    updatedLabel: '更新於',
    authorLabel: 'Graylum 編輯團隊',
    aboutLabel: '關於我們',
    breadcrumbLabel: '目前位置',
    faqTitle: '常見問題',
    relatedTitle: '延伸閱讀',
    rights: '版權所有',
  },
};

export const LANGUAGE_NAMES: Record<SiteLocale, string> = {
  'zh-Hans': '简体中文',
  'zh-TW': '繁體中文（台灣）',
};
