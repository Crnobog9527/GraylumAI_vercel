/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../article';
import { SIGNUP_CTA_HREF } from './shared';

// About pages (SEO_GEO_SPEC 7.5 and 12.5): company, what the product does, how the site is written,
// contact. Founder details wait for wording confirmed by the Owner.
const ALTERNATES = { 'zh-Hans': '/about', 'zh-TW': '/zh-tw/about' } as const;

export const ABOUT_ZH_HANS: ArticleContent = {
  locale: 'zh-Hans',
  path: '/about',
  alternates: ALTERNATES,
  metaTitle: '关于 Graylum – AI 自媒体陪跑教练',
  metaDescription: 'Graylum 是 Grayscale Luminary LLC 开发的 AI 自媒体陪跑教练，帮你找准账号定位、决定每周发什么、写出能直接发的内容。这里介绍公司、编辑原则和联系方式。',
  breadcrumb: [{ name: '首页', path: '/' }, { name: '关于我们', path: '/about' }],
  h1: '关于 Graylum',
  lead: 'Graylum 是一款 AI 自媒体陪跑教练，由美国怀俄明州的 Grayscale Luminary LLC 开发和运营。它通过对话帮你找准账号定位、决定每周发什么，并写出能直接发布的内容。',
  definition: {
    term: 'Graylum 是什么：',
    text: 'Graylum 是面向自媒体新手和个人创作者的 AI 陪跑教练。它像一位运营顾问一样主动提问、帮你把想法说清楚，再给出下一步该做什么。',
  },
  cta: {
    label: '免费开始定位诊断',
    description: '注册后可以免费完成定位诊断：AI 教练会一步步问你的情况，帮你理清适合做什么账号、做给谁看。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: 'Graylum 能帮你做什么？',
      paragraphs: ['Graylum 把一个自媒体运营顾问会做的事拆成几步，每一步都在对话里完成：'],
      list: [
        '定位诊断：通过提问帮你找到适合自己的账号方向和目标受众。',
        '运营策略报告：把定位、受众和内容方向整理成一份可以照着执行的报告（付费会员功能）。',
        '找对标账号：参考同领域做得好的账号，看看别人怎么做。',
        '选题和写内容：决定这周发什么，并写出贴文和视频脚本。',
      ],
    },
    {
      h2: '我们怎么写网站上的内容？',
      paragraphs: ['网站上的每一页都按同样的原则编写和更新：'],
      list: [
        '只介绍已经上线的功能，不写“即将推出”。',
        '不放虚构的用户评价、案例或数据。',
        '引用平台规则或公开资料时注明出处。',
        '每页标出最后更新日期，内容过时会重新检查。',
      ],
    },
    {
      h2: '公司信息',
      paragraphs: [
        'Graylum 由 Grayscale Luminary LLC 开发和运营，公司注册于美国怀俄明州。',
        '商务合作、产品咨询和使用问题，请通过联系我们页面或页脚的邮箱联系。',
      ],
    },
  ],
  related: [
    { label: '联系我们', href: '/contact', description: '商务合作、产品咨询和支持反馈的联系方式。' },
    { label: '价格', href: '/landing/pricing', description: '免费开始，以及会员和积分包的说明。' },
    { label: '常见问题', href: '/faq', description: '使用前最常被问到的问题。' },
  ],
  updated: '2026-10-12',
};

export const ABOUT_ZH_TW: ArticleContent = {
  locale: 'zh-TW',
  path: '/zh-tw/about',
  alternates: ALTERNATES,
  metaTitle: '關於 Graylum – AI 自媒體陪跑教練',
  metaDescription: 'Graylum 是 Grayscale Luminary LLC 開發的 AI 自媒體陪跑教練，幫你找準帳號定位、決定每週發什麼、寫出能直接發的內容。這裡介紹公司、編輯原則與聯絡方式。',
  breadcrumb: [{ name: '自媒體', path: '/zh-tw' }, { name: '關於我們', path: '/zh-tw/about' }],
  h1: '關於 Graylum',
  lead: 'Graylum 是一款 AI 自媒體陪跑教練，由美國懷俄明州的 Grayscale Luminary LLC 開發與營運。它透過對話幫你找準帳號定位、決定每週要發什麼，並寫出可以直接發布的內容。',
  definition: {
    term: 'Graylum 是什麼：',
    text: 'Graylum 是給自媒體新手和個人創作者的 AI 陪跑教練。它像一位經營顧問一樣主動提問、幫你把想法說清楚，再告訴你下一步該做什麼。',
  },
  cta: {
    label: '免費開始定位診斷',
    description: '註冊後可以免費完成定位診斷：AI 教練會一步步了解你的情況，幫你釐清適合經營什麼帳號、做給誰看。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: 'Graylum 能幫你做什麼？',
      paragraphs: ['Graylum 把一位自媒體經營顧問會做的事拆成幾個步驟，每一步都在對話裡完成：'],
      list: [
        '定位診斷：透過提問幫你找到適合自己的帳號方向和目標受眾。',
        '經營策略報告：把定位、受眾和內容方向整理成一份可以照著執行的報告（付費會員功能）。',
        '找對標帳號：參考同領域經營得好的帳號，看看別人怎麼做。',
        '選題和寫內容：決定這週要發什麼，並寫出貼文和影片腳本。',
      ],
    },
    {
      h2: '我們怎麼撰寫網站上的內容？',
      paragraphs: ['網站上的每一頁都依照相同的原則撰寫和更新：'],
      list: [
        '只介紹已經上線的功能，不寫「即將推出」。',
        '不放虛構的使用者評價、案例或數據。',
        '引用平台規則或公開資料時註明出處。',
        '每頁標示最後更新日期，內容過時會重新檢查。',
      ],
    },
    {
      h2: '公司資訊',
      paragraphs: [
        'Graylum 由 Grayscale Luminary LLC 開發與營運，公司登記於美國懷俄明州。',
        '商務合作、產品諮詢和使用問題，請透過聯絡我們頁面或頁尾的電子郵件與我們聯繫。',
      ],
    },
  ],
  related: [
    { label: '自媒體是什麼？', href: '/zh-tw', description: '從零開始認識自媒體，以及 AI 能幫你做什麼。' },
    { label: '聯絡我們（簡體）', href: '/contact', description: '商務合作、產品諮詢和支援回饋的聯絡方式。' },
    { label: '價格（簡體）', href: '/landing/pricing', description: '免費開始，以及會員和點數包的說明。' },
  ],
  updated: '2026-10-12',
};
