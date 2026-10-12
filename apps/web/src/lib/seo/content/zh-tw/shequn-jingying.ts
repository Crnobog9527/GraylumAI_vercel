/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ArticleContent } from '../../article';
import { SIGNUP_CTA_HREF } from '../shared';
import { ZH_TW_CRUMB } from './links';

// Target: 社群經營 (SEO_GEO_SPEC appendix B).
export const ZH_TW_SHEQUN_JINGYING: ArticleContent = {
  locale: 'zh-TW',
  path: '/zh-tw/shequn-jingying',
  metaTitle: '社群經營怎麼做？從規劃、內容到互動的完整流程',
  metaDescription: '社群經營怎麼做？整理規劃主題、建立內容排程、回覆與互動、看數據檢討的完整流程，以及小編一個人經營社群時最實用的省時做法，最後回答貼文頻率、負評處理等常見問題。',
  breadcrumb: [ZH_TW_CRUMB, { name: '社群經營', path: '/zh-tw/shequn-jingying' }],
  h1: '社群經營怎麼做？完整流程一次看',
  lead: '社群經營就是持續用內容和互動，讓一群人願意追蹤你、回來看你、和你對話。流程可以拆成四件事：規劃定位、排程內容、經營互動、檢討數據，每週固定做。',
  keyPoints: [
    '先決定社群的主題和成員是誰，內容才不會散。',
    '內容排程至少提前一週，避免想到才發。',
    '互動是社群經營的核心，留言和私訊要固定時間回。',
  ],
  definition: {
    term: '社群經營是什麼？',
    text: '社群經營是指在 IG、Facebook、Threads、LINE 社群等平台上，透過固定的內容和互動，和受眾建立長期關係的過程。它的成果不只看追蹤數，更看受眾是否願意留言、分享和回訪。',
  },
  cta: {
    label: '免費開始定位診斷',
    description: '社群要經營得起來，先要知道它是為誰而存在。AI 教練會透過對話幫你釐清主題和目標受眾，再規劃內容方向。註冊後即可免費開始。',
    href: SIGNUP_CTA_HREF,
  },
  sections: [
    {
      h2: '社群經營的 4 個步驟',
      paragraphs: ['不論是個人帳號或品牌粉專，都可以照這個循環每週執行。'],
      subsections: [
        { h3: '1. 規劃：主題、成員和語氣', paragraphs: ['寫下社群要談的主題、成員是誰、你希望他們感受到什麼。語氣要一致，例如專業但親切、或是像朋友聊天。'] },
        { h3: '2. 內容：建立排程表', paragraphs: ['用簡單的表格排一週或一個月的內容，分配不同類型：教學、經驗分享、問答、幕後花絮。固定欄目（例如每週五問答）能讓受眾養成期待。'] },
        { h3: '3. 互動：回覆和主動發問', paragraphs: ['每天固定一段時間回覆留言和私訊；在貼文或限時動態主動發問、開投票，讓受眾有參與的理由。把常見問題記下來，就是下一批內容的題目。'] },
        { h3: '4. 檢討：看對的數據', paragraphs: ['除了追蹤數，更要看留言、分享、儲存和回訪。每月比較表現最好和最差的內容，調整下一個月的排程。'] },
      ],
    },
    {
      h2: '一個人經營社群，怎麼省時間？',
      paragraphs: ['小編通常一個人要包辦企劃、製作和回覆。幾個實用的方法：'],
      list: [
        '一次批次製作一週的內容，不要每天臨時想。',
        '一份內容改寫成不同平台的版本，例如長影片剪成短影音、整理成圖卡。',
        '把常見問題整理成固定回覆範本，再依情況調整。',
        '用 AI 協助想題目和寫初稿，自己負責修改和把關。',
      ],
    },
    {
      h2: '社群經營常見的問題',
      paragraphs: ['以下狀況很常見，多半可以從規劃階段避免：'],
      list: [
        '追蹤數增加但沒有互動：內容可能太像廣告，或沒有給受眾留言的理由。',
        '更新斷斷續續：排程太滿，超出自己能長期維持的量。',
        '內容方向一直換：一開始沒有定清楚主題和受眾。',
      ],
    },
    {
      h2: 'AI 可以怎麼協助社群經營？',
      paragraphs: ['Graylum 是 AI 自媒體陪跑教練，會主動提問、幫你理清方向，再一起產出內容：'],
      list: [
        '定位診斷：釐清社群主題和目標受眾（免費）。',
        '經營策略報告：把定位、受眾和內容方向整理成可以照著做的報告（付費會員）。',
        '找對標帳號：參考同領域經營得好的帳號。',
        '選題和寫內容：決定這週發什麼，並寫出貼文和影片腳本。',
      ],
    },
  ],
  faq: [
    {
      question: '社群經營和社群行銷一樣嗎？',
      answer: '不一樣。社群經營重點在和受眾建立長期關係；社群行銷以商業目標為主，例如名單或銷售。經營做得好，行銷才有基礎。',
    },
    {
      question: '社群貼文多久發一次比較好？',
      answer: '沒有標準答案，以能長期維持為原則。多數個人帳號從每週 2～3 篇開始，穩定後再依照數據調整。',
    },
    {
      question: '負評或酸言酸語要怎麼處理？',
      answer: '先分辨是具體意見還是單純情緒。具體意見公開、有禮貌地回應並說明處理方式；單純情緒可以不回應，違反平台規範的再檢舉或隱藏。',
    },
  ],
  related: [
    { label: '自媒體是什麼？', href: '/zh-tw', description: '自媒體的定義、平台和收入來源，一頁看懂。' },
    { label: '社群行銷是什麼？', href: '/zh-tw/shequn-xingxiao', description: '用社群達成品牌認知、名單和銷售的規劃步驟。' },
    { label: '如何經營自媒體？', href: '/zh-tw/zimeiti-jingying', description: '從定位到變現，新手經營自媒體的 6 個步驟。' },
  ],
  sources: [
    { label: 'Instagram 說明中心：關於 Instagram 主控板與洞察報告（英文）', href: 'https://help.instagram.com/257516379077270' },
    { label: 'Instagram 說明中心：隱藏不想看到的留言（英文）', href: 'https://help.instagram.com/700284123459336' },
  ],
  updated: '2026-10-12',
};
