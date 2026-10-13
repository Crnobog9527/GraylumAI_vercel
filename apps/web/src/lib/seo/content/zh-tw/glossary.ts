/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// Simplified → Taiwan Traditional wording for every zh-TW page and, later, the Traditional UI. Taiwan usage,
// not character conversion (SEO_GEO_SPEC 3.1 and 3.3). `avoid` lists mainland or Hong Kong forms that must
// not appear on zh-TW pages; content.test.tsx enforces it.
export type GlossaryEntry = { simplified: string; taiwan: string; avoid: string[] };

export const ZH_TW_GLOSSARY: GlossaryEntry[] = [
  { simplified: '运营策略报告', taiwan: '經營策略報告', avoid: ['運營策略報告'] },
  { simplified: '运营', taiwan: '經營', avoid: ['運營'] },
  { simplified: '积分', taiwan: '點數', avoid: ['積分'] },
  { simplified: '积分包', taiwan: '點數包', avoid: ['積分包'] },
  { simplified: '账号', taiwan: '帳號', avoid: ['賬號', '账号'] },
  { simplified: '视频', taiwan: '影片', avoid: ['視頻'] },
  { simplified: '短视频', taiwan: '短影音', avoid: ['短視頻'] },
  { simplified: '社交媒体', taiwan: '社群', avoid: ['社交媒體'] },
  { simplified: '帖子 / 贴文', taiwan: '貼文', avoid: ['帖子'] },
  { simplified: '关注（动词）', taiwan: '追蹤', avoid: ['關注'] },
  { simplified: '评论', taiwan: '留言', avoid: ['評論'] },
  { simplified: '私信', taiwan: '私訊', avoid: ['私信'] },
  { simplified: '曝光 / 触达', taiwan: '觸及', avoid: ['觸達'] },
  { simplified: '算法', taiwan: '演算法', avoid: [] },
  { simplified: '用户', taiwan: '使用者', avoid: ['用戶'] },
  { simplified: '信息', taiwan: '資訊', avoid: ['信息'] },
  { simplified: '登录', taiwan: '登入', avoid: ['登錄', '登陸'] },
  { simplified: '注册', taiwan: '註冊', avoid: [] },
  { simplified: '邮箱', taiwan: '電子郵件', avoid: ['郵箱'] },
  { simplified: '联系我们', taiwan: '聯絡我們', avoid: ['聯繫我們'] },
  { simplified: '隐私政策', taiwan: '隱私權政策', avoid: [] },
  { simplified: '使用协议', taiwan: '使用規範', avoid: [] },
  { simplified: '质量', taiwan: '品質', avoid: ['質量'] },
  { simplified: '软件', taiwan: '軟體', avoid: ['軟件'] },
  { simplified: '公众主页 / 主页', taiwan: '粉專', avoid: [] },
  { simplified: 'Stories', taiwan: '限時動態', avoid: [] },
  { simplified: 'Instagram Insights', taiwan: '洞察報告', avoid: [] },
  { simplified: 'KOL / 数码营销（香港说法，不用）', taiwan: '網紅 / 數位行銷', avoid: ['KOL', '數碼營銷'] },
];
