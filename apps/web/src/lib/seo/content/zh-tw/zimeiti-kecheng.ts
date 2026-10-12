/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../../article';
import { SIGNUP_CTA_HREF } from '../shared';
import { ZH_TW_CRUMB } from './links';

// Target: 自媒體課程; conversion page comparing courses, human coaching (陪跑) and AI coaching
// (SEO_GEO_SPEC appendix B). No course prices or outcome promises.
export const ZH_TW_ZIMEITI_KECHENG: ArticleContent = {
  locale: 'zh-TW',
  path: '/zh-tw/zimeiti-kecheng',
  metaTitle: '自媒體課程怎麼選？上課、真人陪跑、AI 陪跑比較',
  metaDescription: '自媒體課程怎麼選？比較線上課程、真人陪跑和 AI 陪跑教練的差別、適合對象和挑選重點，幫你在報名前想清楚自己真正需要的是什麼。',
  breadcrumb: [ZH_TW_CRUMB, { name: '自媒體課程', path: '/zh-tw/zimeiti-kecheng' }],
  h1: '自媒體課程怎麼選？上課、真人陪跑、AI 陪跑比較',
  lead: '想學自媒體，主要有三條路：線上課程適合打基礎，真人陪跑適合需要有人盯進度的人，AI 陪跑適合想用較低成本、隨時討論自己帳號的人。先看清楚自己卡在哪裡再選。',
  keyPoints: [
    '缺觀念和方法：課程最有效率。',
    '知道方法但做不下去：需要陪跑和固定檢討。',
    '卡在「我的帳號該怎麼做」：需要針對自己情況的建議。',
  ],
  definition: {
    term: '自媒體陪跑是什麼？',
    text: '自媒體陪跑是指由教練在一段期間內，針對你自己的帳號給定位建議、檢討內容和追進度，而不是只上通用的課。它的價值在於「針對你」和「持續」，這也是它和一般課程最大的差別。',
  },
  cta: {
    label: '免費試試 AI 陪跑',
    description: '先免費做一次定位診斷：AI 教練會像陪跑教練一樣問你的經驗、目標和想服務的人，幫你整理出帳號定位和目標受眾，再決定要不要往下走。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: '線上課程、真人陪跑、AI 陪跑有什麼差別？',
      paragraphs: ['三種方式解決的問題不同，可以依照自己的狀況組合。'],
      subsections: [
        {
          h3: '線上自媒體課程',
          paragraphs: ['錄好的影片或直播課，系統化教定位、拍攝、剪輯、文案和演算法觀念。'],
          list: ['適合：完全新手、想一次建立完整觀念的人。', '限制：內容是通用的，學完怎麼套用到自己的帳號，要靠自己。'],
        },
        {
          h3: '真人陪跑教練',
          paragraphs: ['教練在一段期間內針對你的帳號給建議、檢討內容、追進度。'],
          list: ['適合：需要有人督促、預算比較充足的人。', '限制：費用通常明顯高於課程，能討論的時間受教練排程限制。'],
        },
        {
          h3: 'AI 陪跑教練',
          paragraphs: ['用對話的方式，隨時針對你的帳號討論定位、選題和內容。'],
          list: ['適合：想要針對自己帳號的建議、又希望控制成本的人。', '限制：拍攝、剪輯等實作技巧仍需要自己練習。'],
        },
      ],
    },
    {
      h2: '報名自媒體課程前要先問自己什麼？',
      paragraphs: ['先想清楚這幾題，比比較課程內容更重要：'],
      list: [
        '我卡在哪一步：不知道做什麼、不會做，還是做了沒成效？',
        '我需要的是知識，還是有人針對我的帳號給意見？',
        '課程內容是否和我的平台一致（IG、YouTube、TikTok 的做法差很多）？',
        '講師或教練自己的帳號、案例是否公開可查？',
        '有沒有退費或試聽機制？',
      ],
    },
    {
      h2: '怎麼分辨課程或陪跑值不值得？',
      paragraphs: [
        '留意過度承諾的宣傳，例如保證多少粉絲、保證收入；自媒體成效受主題、內容品質和投入時間影響，沒有人能保證結果。比較可靠的訊號是：課綱具體、有可查證的案例、能先試聽，以及課後有實際練習和回饋。',
      ],
    },
    {
      h2: 'Graylum 的 AI 陪跑怎麼運作？',
      paragraphs: ['Graylum 是 AI 自媒體陪跑教練。它不是只會產生文字的工具，而是會主動提問、幫你把想法說清楚，再給出下一步：'],
      list: [
        '定位診斷：透過對話找出適合你的帳號方向和目標受眾（免費）。',
        '經營策略報告：把定位、受眾和內容方向整理成可以照著做的報告（付費會員）。',
        '找對標帳號：參考同領域經營得好的帳號。',
        '選題和寫內容：決定這週發什麼，並寫出貼文和短影音腳本。',
      ],
    },
  ],
  faq: [
    {
      question: '完全新手應該先上課還是先找陪跑？',
      answer: '如果連基本觀念都沒有，先上一門基礎課建立框架；如果已經開始經營但不知道方向對不對，陪跑或 AI 陪跑會更直接。',
    },
    {
      question: 'AI 陪跑可以取代真人教練嗎？',
      answer: '在定位、選題、寫內容這類需要反覆討論的地方，AI 陪跑可以隨時回應、成本也較低；需要真人示範拍攝技巧或人脈資源時，真人教練仍有價值。',
    },
    {
      question: 'Graylum 要付費嗎？',
      answer: '定位診斷可以免費開始；完整的經營策略報告需要付費會員，方案請參考價格頁。',
    },
  ],
  related: [
    { label: '自媒體是什麼？', href: '/zh-tw', description: '自媒體的定義、平台和收入來源，一頁看懂。' },
    { label: '如何經營自媒體？', href: '/zh-tw/zimeiti-jingying', description: '從定位到變現，新手經營自媒體的 6 個步驟。' },
    { label: 'IG 經營全攻略', href: '/zh-tw/ig-jingying', description: '新手如何經營 IG：帳號設定、內容形式和數據。' },
    { label: '價格（簡體）', href: '/landing/pricing', description: '免費開始，以及會員和點數包的說明。' },
  ],
  updated: '2026-10-12',
};
