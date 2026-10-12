/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../../article';
import { SIGNUP_CTA_HREF } from '../shared';

// Taiwan hub page, "the second home page" (SEO_GEO_SPEC 3.3 and appendix B): core word 自媒體, answers
// 自媒體是什麼. The 自媒體經營 family belongs to /zh-tw/zimeiti-jingying, so this page does not target it.
export const ZH_TW_HUB: ArticleContent = {
  locale: 'zh-TW',
  path: '/zh-tw',
  metaTitle: '自媒體是什麼？AI 自媒體陪跑教練帶你從定位開始',
  metaDescription: '自媒體是什麼、有哪些平台、怎麼開始和怎麼賺錢，一頁講清楚。用 AI 自媒體陪跑教練免費做定位診斷，找到適合你的帳號方向。',
  breadcrumb: [{ name: '自媒體', path: '/zh-tw' }],
  h1: '你的 AI 自媒體陪跑教練',
  lead: '自媒體就是自己當媒體：一個人或小團隊在 IG、YouTube、TikTok、Threads 等平台產出內容、累積受眾。新手最容易卡在第一步「要做什麼、做給誰看」，Graylum 用對話陪你把這一步想清楚。',
  keyPoints: [
    '先決定定位和目標受眾，再挑平台和內容形式。',
    '固定節奏更新比偶爾爆紅更重要。',
    '每隔一段時間看數據、調整方向。',
  ],
  definition: {
    term: '自媒體是什麼？',
    text: '自媒體是指個人或小團隊不透過傳統媒體，自己在社群平台、影音平台或部落格上產出內容、經營受眾的方式。內容、發布時間和經營方向都由自己決定，收入通常來自業配合作、聯盟行銷、自有產品或平台分潤。',
  },
  cta: {
    label: '免費開始定位診斷',
    description: '不知道該經營什麼帳號？AI 教練會一步步問你的興趣、經驗和想服務的人，幫你整理出適合的帳號定位和目標受眾。註冊後即可免費開始。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: '自媒體有哪些平台？',
      paragraphs: ['不同平台適合不同的內容形式。新手不必每個平台都做，先選一個和自己內容最合的平台，經營穩定再延伸。'],
      subsections: [
        { h3: '短影音：IG Reels、TikTok、YouTube Shorts', paragraphs: ['節奏快、觸及新受眾的機會多，適合教學重點、生活片段和觀點分享。'] },
        { h3: '長影片：YouTube', paragraphs: ['適合完整教學、評測和深度內容，觀眾停留時間長，也比較容易被搜尋找到。'] },
        { h3: '圖文和社群：IG、Threads、Facebook', paragraphs: ['適合圖卡、懶人包和日常互動，也是和粉絲建立關係的主要地方。'] },
        { h3: '文字和聲音：部落格、電子報、Podcast', paragraphs: ['適合喜歡寫作或說話的人，內容可以被長期搜尋到，受眾黏著度通常較高。'] },
      ],
    },
    {
      h2: '經營自媒體要從哪裡開始？',
      paragraphs: ['多數人一開始就急著拍片或發文，結果做了幾個月不知道問題在哪。比較穩的順序是（每一步的做法見〈如何經營自媒體〉）：'],
      list: [
        '定位：你要分享什麼主題？你和別人有什麼不一樣？',
        '受眾：你想幫誰解決什麼問題？他們會在哪個平台？',
        '內容支柱：定出 3～5 個固定主題，之後的選題都從這裡長出來。',
        '更新節奏：選一個能長期做到的頻率，例如每週 2～3 篇。',
        '檢討調整：定期看哪些內容表現好，再決定下一步。',
      ],
    },
    {
      h2: '自媒體怎麼賺錢？',
      paragraphs: ['常見的收入來源有幾種，多數創作者會隨著受眾成長逐步組合：'],
      list: [
        '業配與品牌合作：替品牌介紹產品或服務。',
        '聯盟行銷：分享商品連結，成交後拿分潤。',
        '自有產品或服務：課程、電子書、諮詢或實體商品。',
        '平台分潤和會員訂閱：例如影片廣告分潤、付費訂閱。',
      ],
    },
    {
      h2: 'AI 能幫你經營自媒體嗎？',
      paragraphs: [
        'AI 最能幫上忙的，是那些需要反覆思考、但沒有人可以討論的環節。Graylum 不是只會產生文字的工具，它會主動提問、幫你把想法說清楚，再給出下一步：',
      ],
      list: [
        '定位診斷：透過對話找到適合你的帳號方向和目標受眾（免費）。',
        '經營策略報告：把定位、受眾和內容方向整理成可以照著做的報告（付費會員）。',
        '找對標帳號：參考同領域經營得好的帳號。',
        '選題和寫內容：決定這週發什麼，並寫出貼文和短影音腳本。',
      ],
    },
  ],
  faq: [
    {
      question: '自媒體和網紅一樣嗎？',
      answer: '不完全一樣。網紅通常指已經有大量粉絲、以個人形象為主的創作者；自媒體則是一種經營方式，不一定要露臉，也不一定要很多粉絲，重點是持續產出對受眾有用的內容。',
    },
    {
      question: '不露臉可以經營自媒體嗎？',
      answer: '可以。圖卡、懶人包、螢幕錄影教學、配音影片和文字內容都不需要露臉，關鍵是定位清楚、內容對受眾有價值。',
    },
    {
      question: '一個人可以經營自媒體嗎？',
      answer: '可以，大部分自媒體一開始都是一個人。把流程簡化成固定的選題、製作、發布和檢討，就能長期維持；AI 工具可以幫你分擔想題目和寫初稿的時間。',
    },
    {
      question: '使用 Graylum 要付費嗎？',
      answer: '定位診斷可以免費開始。完整的經營策略報告需要付費會員，詳細方案請參考價格頁。',
    },
  ],
  related: [
    { label: '如何經營自媒體？', href: '/zh-tw/zimeiti-jingying', description: '從定位到變現，新手經營自媒體的 6 個步驟。' },
    { label: 'IG 經營全攻略', href: '/zh-tw/ig-jingying', description: '新手如何經營 IG：帳號設定、內容形式和數據。' },
    { label: '社群行銷是什麼？', href: '/zh-tw/shequn-xingxiao', description: '個人與小品牌用社群達成名單和銷售的做法。' },
    { label: '社群經營怎麼做？', href: '/zh-tw/shequn-jingying', description: '從規劃、內容到互動的社群經營流程。' },
    { label: '自媒體課程怎麼選？', href: '/zh-tw/zimeiti-kecheng', description: '上課、真人陪跑和 AI 陪跑的差別與適合對象。' },
    { label: '關於 Graylum', href: '/zh-tw/about', description: '公司資訊、編輯原則和聯絡方式。' },
    { label: '價格（簡體）', href: '/landing/pricing', description: '免費開始，以及會員和點數包的說明。' },
  ],
  updated: '2026-10-12',
};
