/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../../article';
import { SIGNUP_CTA_HREF } from '../shared';
import { ZH_TW_CRUMB } from './links';

// Target: IG 經營 + 如何經營 IG; tips and courses stay on this page (SEO_GEO_SPEC appendix B).
export const ZH_TW_IG_JINGYING: ArticleContent = {
  locale: 'zh-TW',
  path: '/zh-tw/ig-jingying',
  metaTitle: 'IG 經營全攻略：新手如何經營 IG 帳號',
  metaDescription: '如何經營 IG？從帳號定位、整理個人檔案、分配 Reels 和貼文、固定更新頻率，到怎麼看洞察報告調整內容，一步步整理新手 IG 經營的做法，再加上改了就有差的實用技巧。',
  breadcrumb: [ZH_TW_CRUMB, { name: 'IG 經營', path: '/zh-tw/ig-jingying' }],
  h1: 'IG 經營全攻略：新手如何經營 IG',
  lead: 'IG 經營的關鍵是：定位清楚、個人檔案一眼看懂、Reels 負責觸及新受眾、貼文和限時動態負責建立信任，再用洞察報告每週調整。下面按步驟說明。',
  keyPoints: [
    '先切換成專業帳號，才看得到洞察報告。',
    'Reels 觸及新受眾，輪播貼文適合被儲存，限時動態維繫老粉。',
    '每週看一次觸及、儲存和分享，比只看按讚更準。',
  ],
  definition: {
    term: 'IG 經營是什麼？',
    text: 'IG 經營是指有計畫地規劃 Instagram 帳號的定位、內容形式和更新節奏，並透過互動與數據調整，讓帳號穩定累積目標受眾。它不只是發照片，而是把每一篇內容都對準同一群人。',
  },
  cta: {
    label: '免費開始定位診斷',
    description: '不確定 IG 要經營什麼主題？AI 教練會透過對話問你的經驗和想服務的人，幫你整理出帳號定位和目標受眾。註冊後即可免費開始。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: '如何經營 IG？5 個步驟',
      paragraphs: ['適合從零開始或想重新整理帳號的人。'],
      subsections: [
        { h3: '1. 定位：這個帳號為誰提供什麼', paragraphs: ['用一句話說清楚，例如「幫小資族用 30 分鐘做出一週便當」。之後每篇內容都問自己：這篇對這群人有用嗎？'] },
        { h3: '2. 整理個人檔案', paragraphs: ['名稱可以加上主題關鍵字，簡介寫清楚「你是誰、能帶給追蹤者什麼、下一步去哪裡」。精選限時動態放最重要的介紹和常見問題。'] },
        { h3: '3. 分配內容形式', paragraphs: ['Reels 適合觸及還不認識你的人；輪播貼文適合教學和懶人包，容易被儲存；限時動態適合日常互動、投票和問答。三種形式搭配，不要只做一種。'] },
        { h3: '4. 固定更新節奏', paragraphs: ['選一個能維持的頻率，例如每週 2 支 Reels、1 篇輪播，限時動態盡量每天更新。穩定比數量重要。'] },
        { h3: '5. 用洞察報告調整', paragraphs: ['切換成專業帳號（創作者或商業帳號）後，可以在洞察報告看到每篇內容的觸及、互動和追蹤來源。每週找出表現最好的內容，分析主題和開頭，下週多做類似的。'] },
      ],
    },
    {
      h2: 'IG 經營有哪些實用技巧？',
      paragraphs: ['以下幾點是新手最容易忽略、改了就有差的地方：'],
      list: [
        'Reels 的前 3 秒直接講重點或丟出問題，不要長篇自我介紹。',
        '輪播第一張當標題頁，讓人一眼知道滑下去能得到什麼。',
        '文案結尾給一個簡單的行動，例如「你會選哪一個？留言告訴我」。',
        'Hashtag 少量但精準，選和內容主題直接相關的標籤。',
        '發文後一小時內回覆留言，和早期互動的人多聊幾句。',
      ],
    },
    {
      h2: 'IG 經營要多久才會有起色？',
      paragraphs: [
        '因主題和內容品質而異，通常需要持續幾個月才看得出趨勢。建議以 8～12 週為一輪：固定定位和節奏，期滿用洞察報告判斷要加碼哪一類內容。',
      ],
    },
    {
      h2: '要上 IG 經營課程，還是自己摸索？',
      paragraphs: [
        '課程適合想要系統化學習基本功的人；自己摸索成本低但容易繞路。另一種選擇是 AI 陪跑：Graylum 是 AI 自媒體陪跑教練，會依照你的帳號狀況主動提問，給出下一步：',
      ],
      list: [
        '定位診斷：找出適合你的 IG 帳號方向和目標受眾（免費）。',
        '經營策略報告：把定位、受眾和內容方向整理成可以照著做的報告（付費會員）。',
        '找對標帳號：參考同領域經營得好的 IG 帳號。',
        '選題和寫內容：決定這週發什麼，並寫出貼文文案和影片腳本。',
      ],
    },
  ],
  faq: [
    {
      question: 'IG 個人帳號和專業帳號有什麼差別？',
      answer: '專業帳號（創作者或商業帳號）可以看洞察報告、設定聯絡按鈕和分類標籤；切換是免費的，想經營帳號建議切換。',
    },
    {
      question: 'IG 經營一定要拍 Reels 嗎？',
      answer: '不一定，但 Reels 是接觸新受眾的主要形式之一。不想露臉可以做圖文動畫、螢幕錄影或配音影片。',
    },
    {
      question: 'IG 經營可以賺錢嗎？',
      answer: '可以，常見方式有業配合作、聯盟行銷、販售自己的產品或服務。先累積信任你的受眾，變現會比較順利。',
    },
  ],
  related: [
    { label: '自媒體是什麼？', href: '/zh-tw', description: '自媒體的定義、平台和收入來源，一頁看懂。' },
    { label: '如何經營自媒體？', href: '/zh-tw/zimeiti-jingying', description: '從定位到變現，新手經營自媒體的 6 個步驟。' },
    { label: '自媒體課程怎麼選？', href: '/zh-tw/zimeiti-kecheng', description: '上課、真人陪跑和 AI 陪跑的差別與適合對象。' },
  ],
  sources: [
    { label: 'Instagram 說明中心：設定專業帳號（英文）', href: 'https://help.instagram.com/502981923235522' },
    { label: 'Instagram 說明中心：關於 Instagram 主控板與洞察報告（英文）', href: 'https://help.instagram.com/257516379077270' },
    { label: 'Instagram 官方：Instagram Ranking Explained（各版位的排序方式，英文）', href: 'https://about.instagram.com/blog/announcements/instagram-ranking-explained' },
    { label: 'Instagram for Creators：Tips for Improving Your Reach（英文）', href: 'https://creators.instagram.com/blog/tips-for-improving-your-reach' },
  ],
  updated: '2026-10-12',
};
