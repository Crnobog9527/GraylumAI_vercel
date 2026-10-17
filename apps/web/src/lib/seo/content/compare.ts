/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { formatUsd, pickPaywallPlans, type PaywallPlanSource } from '@/components/paywall/paywallPlans';
import type { ArticleContent } from '../article';
import { landingFaq, signupGrantShown } from './landing-faq-pick';
import { SIGNUP_CTA_HREF, SIGNUP_GRANT_CREDITS } from './shared';
import { ZH_TW_CRUMB } from './zh-tw/links';

// "Graylum 和 ChatGPT 做自媒体有什么不同？" in Simplified (/graylum-vs-chatgpt) and Taiwan Traditional
// (/zh-tw/graylum-vs-chatgpt), SEO_GEO_SPEC section 12 item 9 and the 2026-10-18 keyword table. Rules for these pages:
// state only facts that can be checked, never run the other product down, and date every statement about ChatGPT with
// the day it was checked against OpenAI's own pages (COMPARED_ON). Graylum's price is read from the plan catalog, never typed.
export const COMPARED_ON = '2026-10-18';
export const CHATGPT_SOURCES = [
  { label: 'OpenAI：ChatGPT 套餐与定价（ChatGPT Plans and Pricing）', href: 'https://chatgpt.com/pricing/' },
  { label: 'OpenAI 帮助中心：About ChatGPT Pro tiers（英文）', href: 'https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers' },
  { label: 'OpenAI 帮助中心：Memory in ChatGPT（英文）', href: 'https://help.openai.com/en/articles/8590148-memory-faq' },
];
const CHATGPT_SOURCES_TW = [
  { label: 'OpenAI：ChatGPT 方案與定價（ChatGPT Plans and Pricing，英文）', href: CHATGPT_SOURCES[0].href },
  { label: 'OpenAI 說明中心：About ChatGPT Pro tiers（英文）', href: CHATGPT_SOURCES[1].href },
  { label: 'OpenAI 說明中心：Memory in ChatGPT（英文）', href: CHATGPT_SOURCES[2].href },
];

export const COMPARE_PATH = '/graylum-vs-chatgpt';
export const COMPARE_PATH_TW = '/zh-tw/graylum-vs-chatgpt';
const ALTERNATES = { 'zh-Hans': COMPARE_PATH, 'zh-TW': COMPARE_PATH_TW } as const;

function graylumPrice(plans: readonly PaywallPlanSource[], zh: 'hans' | 'tw') {
  const pro = pickPaywallPlans(plans).find(plan => plan.level === 'pro');
  const grant = signupGrantShown();
  const free = zh === 'hans' ? (grant ? `免费开始，注册送 ${SIGNUP_GRANT_CREDITS} 积分` : '免费开始')
    : (grant ? `免費開始，註冊送 ${SIGNUP_GRANT_CREDITS} 點數` : '免費開始');
  if (!pro) return zh === 'hans' ? `${free}；会员价格见价格页` : `${free}；會員價格見價格頁`;
  const price = formatUsd(pro.price.monthly);
  return zh === 'hans' ? `${free}；会员 Pro 每月 ${price} 起` : `${free}；會員 Pro 每月 ${price} 起`;
}

/** Simplified comparison page. `plans` is the public plan catalog (empty when it cannot be read). */
export function compareHans(plans: readonly PaywallPlanSource[] = []): ArticleContent {
  return {
    locale: 'zh-Hans',
    path: COMPARE_PATH,
    alternates: ALTERNATES,
    metaTitle: 'Graylum 和 ChatGPT 做自媒体有什么不同？',
    metaDescription: '做自媒体该用 ChatGPT 还是 Graylum？按定位怎么做、记不记得你的情况、有没有完整报告、能不能多模型评审和价格逐项对比，并说明什么情况下用 ChatGPT 就够了，帮你判断哪个更适合现在的你。',
    breadcrumb: [{ name: '首页', path: '/' }, { name: 'Graylum 和 ChatGPT 的不同', path: COMPARE_PATH }],
    h1: 'Graylum 和 ChatGPT 做自媒体有什么不同？',
    lead: 'ChatGPT 是通用 AI，什么都能聊；Graylum 是专门陪你做自媒体的教练，分步提问、每步由你确认、出完整报告。',
    keyPoints: [
      '临时问一个问题、改一段文案，ChatGPT 就够用。',
      '想从零想清楚账号定位、持续做选题和写稿，Graylum 更省事。',
      '两者不是二选一：你可以继续用 ChatGPT 处理零散的事。',
    ],
    definition: {
      term: '两者最大的区别：',
      text: 'ChatGPT 是通用的 AI 助手，你问什么它答什么，怎么问、怎么整理由你自己决定。Graylum 是 AI 自媒体陪跑教练，它按一套步骤主动向你提问，每一步由你确认，并把聊到的内容整理成清单和报告。',
    },
    cta: {
      label: '免费和教练聊聊',
      description: '想看看分步定位是什么感觉？注册后可以免费开始，和 AI 教练聊一次。',
      href: SIGNUP_CTA_HREF,
    },
    sections: [
      {
        h2: '两者各适合做什么？',
        paragraphs: [
          'ChatGPT 适合随时问任何问题：写一段草稿、改一版文案、头脑风暴、分析你贴给它的材料。它很灵活，但每次从哪里开始、问什么、怎么把结果整理起来，都要你自己来。',
          'Graylum 适合还没想清楚账号做什么、给谁看，或者想有节奏地做选题、写稿、看报告的人：教练先问你的情况，再一步步带你往下走。',
        ],
      },
      {
        h2: '逐项对比：定位、记忆、报告、评审和价格',
        paragraphs: [`下面是按做自媒体常见的几件事做的对比。关于 ChatGPT 的内容，以 ${COMPARED_ON} 查阅的 OpenAI 官方页面为准，页面底部列出了来源。`],
        table: {
          caption: 'Graylum 和 ChatGPT 做自媒体的对比',
          head: ['比较项', 'ChatGPT', 'Graylum'],
          rows: [
            ['做账号定位', '可以聊定位，由你来提问、追问和整理。', '教练分三步主动提问，每一步由你确认，聊到的信息边聊边记成清单。'],
            ['记住你的情况', `有记忆功能：可以保存你的信息，也可以参考过往对话，并可在设置里关闭（OpenAI 帮助中心，${COMPARED_ON} 查阅）。`, '你确认过的定位和资料保存在清单和资料库里，换窗口、换天都找得到。'],
            ['完整的定位报告', '对话式：你提出要求，它来回答；要不要整理成报告、怎么整理，由你自己决定。', '三步走完可以生成按章节阅读的定位与执行方案报告（付费会员功能）。'],
            ['多模型评审', '对话式：怎么对比不同的答案，由你自己决定。', '评审团让几个不同的大模型分别审报告，有分歧再辩一轮，汇总成修订稿（Gold 会员功能）。'],
            ['价格', `有免费版和付费版：Plus 每月 $20，Pro 每月 $100 起（OpenAI 官方页面，${COMPARED_ON} 查阅，以官方页面为准）。`, `${graylumPrice(plans, 'hans')}（以价格页为准）。`],
          ],
        },
      },
      {
        h2: '什么情况下，用 ChatGPT 就够了？',
        paragraphs: ['下面这些情况，不一定需要 Graylum：'],
        list: [
          '只是临时问一个问题，或者改一段已经写好的文案。',
          '你已经有清楚的账号定位和固定的发布节奏，只是需要一个随叫随到的写作帮手。',
          '你更习惯自己掌控提问方式，不需要有人带着走步骤。',
        ],
      },
      {
        h2: 'Graylum 不能替你做什么？',
        paragraphs: ['为了说清楚，也把 Graylum 做不到的事写在这里：'],
        list: [
          '不能保证涨粉或赚钱：账号能不能做起来，取决于你的投入、内容和平台环境。',
          '不能替你拍摄、出镜和录音，这些要你本人来。',
          '不能代替你对自己账号的判断：教练给建议，每一步由你确认。',
        ],
      },
    ],
    faq: [
      {
        question: '我已经在用 ChatGPT 了，还需要 Graylum 吗？',
        answer: '看你卡在哪里。如果卡在"不知道该做什么、给谁看"或者"每周不知道发什么"，分步提问的教练会更省事；如果只是零散的写作需求，继续用 ChatGPT 就行，两者可以一起用。',
      },
      ...landingFaq('faq-11'),
    ],
    related: [
      { label: '定位分析', href: '/features/positioning', description: '三步对话想清楚账号做什么、给谁看。' },
      { label: '评审团', href: '/features/jury', description: '几个不同的大模型分别审报告，有分歧再辩一轮。' },
      { label: '价格', href: '/landing/pricing', description: '免费开始，以及会员和积分包的说明。' },
    ],
    sources: CHATGPT_SOURCES,
    updated: COMPARED_ON,
    published: COMPARED_ON,
  };
}

/** Taiwan Traditional comparison page: written for Taiwanese readers, not translated from the Simplified one. */
export function compareTw(plans: readonly PaywallPlanSource[] = []): ArticleContent {
  return {
    locale: 'zh-TW',
    path: COMPARE_PATH_TW,
    alternates: ALTERNATES,
    metaTitle: 'Graylum 和 ChatGPT 經營自媒體差在哪？',
    metaDescription: '經營自媒體該用 ChatGPT 還是 Graylum？從定位怎麼做、記不記得你的狀況、有沒有完整報告、能不能多模型評審和價格逐項比較，也說明哪些情況用 ChatGPT 就夠了，幫你判斷哪個更適合現在的你。',
    breadcrumb: [ZH_TW_CRUMB, { name: 'Graylum 和 ChatGPT 的差別', path: COMPARE_PATH_TW }],
    h1: 'Graylum 和 ChatGPT 經營自媒體差在哪？',
    lead: 'ChatGPT 是通用 AI，什麼都能聊；Graylum 是專門陪你經營自媒體的教練，分步提問、每步由你確認、產出完整報告。',
    keyPoints: [
      '臨時問個問題、改一段文案，用 ChatGPT 就夠了。',
      '想從零想清楚帳號定位、持續規劃選題和寫腳本，Graylum 比較省事。',
      '兩者不是二選一，零碎的事可以繼續交給 ChatGPT。',
    ],
    definition: {
      term: '兩者最大的差別：',
      text: 'ChatGPT 是通用的 AI 助手，你問什麼它答什麼，怎麼問、怎麼整理都由你自己決定。Graylum 是 AI 自媒體陪跑教練，會依照一套步驟主動向你提問，每一步由你確認，再把聊到的內容整理成清單和報告。',
    },
    cta: {
      label: '免費和教練聊聊',
      description: '想知道分步定位是什麼感覺？註冊後可以免費開始，和 AI 教練聊一次。',
      href: SIGNUP_CTA_HREF,
    },
    sections: [
      {
        h2: '兩者各適合做什麼？',
        paragraphs: [
          'ChatGPT 適合隨時問各種問題：寫一段草稿、改一版文案、腦力激盪、分析你貼給它的資料。它很靈活，但每次從哪裡開始、問什麼、怎麼把結果整理起來，都要你自己來。',
          'Graylum 適合還沒想清楚帳號要做什麼、給誰看，或是想有節奏地規劃選題、寫腳本、看報告的人：教練先了解你的狀況，再一步一步帶你往下走。',
        ],
      },
      {
        h2: '逐項比較：定位、記憶、報告、評審和價格',
        paragraphs: [`下面依照經營自媒體常遇到的幾件事做比較。關於 ChatGPT 的內容，以 ${COMPARED_ON} 查閱的 OpenAI 官方頁面為準，來源列在頁面底部。`],
        table: {
          caption: 'Graylum 和 ChatGPT 經營自媒體的比較',
          head: ['比較項目', 'ChatGPT', 'Graylum'],
          rows: [
            ['做帳號定位', '可以聊定位，由你自己提問、追問和整理。', '教練分三步主動提問，每一步由你確認，聊到的資訊邊聊邊記成清單。'],
            ['記住你的狀況', `有記憶功能：可以儲存你的資訊，也能參考過去的對話，並可在設定中關閉（OpenAI 說明中心，${COMPARED_ON} 查閱）。`, '你確認過的定位和資料存在清單與資料庫裡，換視窗、換天都找得到。'],
            ['完整的定位報告', '對話式：由你提出需求、它來回答；要不要整理成報告、怎麼整理，都由你自己決定。', '三步走完可以產出依章節閱讀的定位與執行方案報告（付費會員功能）。'],
            ['多模型評審', '對話式：怎麼比對不同的答案，由你自己決定。', '評審團讓幾個不同的大模型分別審閱報告，有分歧再討論一輪，彙整成修訂稿（Gold 會員功能）。'],
            ['價格', `有免費版和付費版：Plus 每月 $20，Pro 每月 $100 起（OpenAI 官方頁面，${COMPARED_ON} 查閱，以官方頁面為準）。`, `${graylumPrice(plans, 'tw')}（以價格頁為準）。`],
          ],
        },
      },
      {
        h2: '什麼情況下，用 ChatGPT 就夠了？',
        paragraphs: ['以下這些情況，不一定需要 Graylum：'],
        list: [
          '只是臨時問個問題，或是修改一段已經寫好的文案。',
          '你已經有清楚的帳號定位和固定的發文節奏，只需要一個隨時能問的寫作幫手。',
          '你習慣自己掌握提問方式，不需要有人帶著走步驟。',
        ],
      },
      {
        h2: 'Graylum 不能替你做什麼？',
        paragraphs: ['為了說清楚，也把 Graylum 做不到的事寫在這裡：'],
        list: [
          '不能保證漲粉或賺錢：帳號做不做得起來，取決於你的投入、內容和平台環境。',
          '不能替你拍攝、出鏡和錄音，這些要由你本人來。',
          '不能取代你對自己帳號的判斷：教練給建議，每一步由你確認。',
        ],
      },
    ],
    faq: [
      {
        question: '我已經在用 ChatGPT 了，還需要 Graylum 嗎？',
        answer: '看你卡在哪裡。如果卡在「不知道要做什麼、給誰看」或是「每週不知道發什麼」，分步提問的教練會比較省事；如果只是零碎的寫作需求，繼續用 ChatGPT 就好，兩者可以搭配使用。',
      },
      {
        question: '免費可以先試什麼？',
        answer: '註冊後可以免費開始，不用綁卡，先和 AI 教練聊一次，把你的狀況聊清楚、把定位整理出來。想要完整的報告和評審團，再看會員方案。',
      },
    ],
    related: [
      { label: '自媒體是什麼？', href: '/zh-tw', description: '自媒體的定義、平台和收入來源，一頁看懂。' },
      { label: '如何經營自媒體？', href: '/zh-tw/zimeiti-jingying', description: '從定位到變現，新手經營自媒體的 6 個步驟。' },
      { label: '自媒體課程怎麼選？', href: '/zh-tw/zimeiti-kecheng', description: '上課、真人陪跑和 AI 陪跑的差別與適合對象。' },
    ],
    sources: CHATGPT_SOURCES_TW,
    updated: COMPARED_ON,
    published: COMPARED_ON,
  };
}
