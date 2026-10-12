/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../../article';
import { SIGNUP_CTA_HREF } from '../shared';
import { ZH_TW_CRUMB } from './links';

// Target: 社群行銷 (SEO_GEO_SPEC appendix B).
export const ZH_TW_SHEQUN_XINGXIAO: ArticleContent = {
  locale: 'zh-TW',
  path: '/zh-tw/shequn-xingxiao',
  metaTitle: '社群行銷是什麼？個人與小品牌的 6 步驟做法',
  metaDescription: '社群行銷是什麼？和社群經營差在哪裡？從設定目標、定義受眾、選平台、規劃內容、經營互動到追蹤成效，整理給個人創作者和小品牌照著做的 6 個步驟，並列出最常見的錯誤。',
  breadcrumb: [ZH_TW_CRUMB, { name: '社群行銷', path: '/zh-tw/shequn-xingxiao' }],
  h1: '社群行銷是什麼？個人與小品牌怎麼做',
  lead: '社群行銷是在 IG、Facebook、Threads、YouTube 等社群平台上，用內容和互動讓目標受眾認識、信任並購買你的產品或服務。做法的核心是：先定目標和受眾，再決定平台和內容。',
  keyPoints: [
    '先有明確目標（品牌認知、名單或銷售），才知道要看哪些數據。',
    '平台跟著受眾走，不是跟著流行走。',
    '內容以「對受眾有用」為主，推銷內容只佔一小部分。',
  ],
  definition: {
    term: '社群行銷的定義：',
    text: '社群行銷（social media marketing）是利用社群平台的內容、互動和廣告，達成品牌認知、累積潛在顧客或促成銷售的行銷方式。和傳統廣告最大的不同，是它需要長期經營關係，而不是一次性曝光。',
  },
  cta: {
    label: '免費開始定位診斷',
    description: '社群行銷的第一步是講清楚「你是誰、為誰服務」。AI 教練會透過對話幫你整理品牌定位和目標受眾，再往下規劃內容。註冊後即可免費開始。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: '社群行銷和社群經營有什麼不同？',
      paragraphs: [
        '兩者常被混用，但重點不一樣：社群行銷以商業目標為主，例如帶來名單或訂單；社群經營偏重和受眾建立長期關係，讓粉絲願意互動、回訪和推薦。實務上兩者要一起做，經營打底，行銷才有效。',
      ],
    },
    {
      h2: '社群行銷怎麼做？6 個步驟',
      paragraphs: ['以下流程適合預算有限的個人品牌和小店家。'],
      subsections: [
        { h3: '1. 設定目標', paragraphs: ['三個月內最想達成什麼？讓更多人認識、收集名單，還是直接帶來訂單？一次只設一個主要目標。'] },
        { h3: '2. 定義目標受眾', paragraphs: ['他們是誰、有什麼困擾、在哪個平台活躍、會因為什麼而購買。寫得越具體，內容越容易打中。'] },
        { h3: '3. 選擇平台', paragraphs: ['在台灣，Facebook 和 LINE 官方帳號適合經營既有顧客，IG 和 Threads 適合年輕族群和視覺型產品，YouTube 適合需要深入說明的產品或服務。先選一到兩個主力平台。'] },
        { h3: '4. 規劃內容', paragraphs: ['把內容分成三類：教育（解決受眾問題）、信任（幕後、案例、觀點）、轉換（產品介紹、優惠）。大部分內容應該是前兩類。'] },
        { h3: '5. 經營互動', paragraphs: ['回覆留言和私訊、在限時動態和受眾對話。互動不只是禮貌，也是了解受眾需求最直接的管道。'] },
        { h3: '6. 追蹤成效、調整', paragraphs: ['依照目標選指標：認知看觸及和新追蹤，名單看點擊和表單，銷售看轉換。每月檢討一次，留下有效的內容形式。'] },
      ],
    },
    {
      h2: '社群行銷常見的錯誤',
      paragraphs: ['以下幾種情況最容易讓預算和時間白費：'],
      list: [
        '每篇都在推銷產品，受眾覺得像廣告而不想追蹤。',
        '每個平台都開帳號，結果每個都經營得很淺。',
        '只追求按讚數，沒有對應到真正的商業目標。',
        '沒有固定更新節奏，受眾和演算法都記不住你。',
      ],
    },
    {
      h2: 'AI 可以怎麼協助社群行銷？',
      paragraphs: ['小團隊最缺的是有人一起想策略。Graylum 是 AI 自媒體陪跑教練，會主動提問，陪你把行銷規劃落地：'],
      list: [
        '定位診斷：釐清品牌定位和目標受眾（免費）。',
        '經營策略報告：把定位、受眾和內容方向整理成可以照著做的報告（付費會員）。',
        '找對標帳號：參考同領域經營得好的帳號。',
        '選題和寫內容：決定這週發什麼，並寫出貼文和影片腳本。',
      ],
    },
  ],
  faq: [
    {
      question: '社群行銷一定要下廣告嗎？',
      answer: '不一定。先用自然內容找出受眾有反應的主題，再把表現好的內容拿去投廣告，花費會更有效率。',
    },
    {
      question: '小店家應該先經營哪個平台？',
      answer: '看顧客在哪裡。既有顧客多半在 Facebook 或 LINE 的話，先經營那裡維繫關係；想接觸新的年輕客群，再加上 IG 或 Threads。',
    },
    {
      question: '社群行銷多久看得到效果？',
      answer: '自然內容通常需要幾個月累積，廣告則可以較快看到數據。建議以三個月為一個週期設定目標並檢討。',
    },
  ],
  related: [
    { label: '自媒體是什麼？', href: '/zh-tw', description: '自媒體的定義、平台和收入來源，一頁看懂。' },
    { label: '社群經營怎麼做？', href: '/zh-tw/shequn-jingying', description: '行銷之外，怎麼透過互動把粉絲變成社群。' },
    { label: 'IG 經營全攻略', href: '/zh-tw/ig-jingying', description: '把 IG 當主力平台的帳號設定和內容做法。' },
  ],
  sources: [
    { label: 'LINE Biz-Solutions：LINE 官方帳號介紹', href: 'https://tw.linebiz.com/service/account-solutions/line-official-account/' },
    { label: 'Instagram 官方：Instagram Ranking Explained（各版位的排序方式，英文）', href: 'https://about.instagram.com/blog/announcements/instagram-ranking-explained' },
  ],
  updated: '2026-10-12',
};
