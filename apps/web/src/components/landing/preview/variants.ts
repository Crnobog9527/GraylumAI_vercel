/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The public-page style samples for the Owner to choose from (not public; removed after the choice). */
export const PREVIEW_VARIANTS = [
  {
    id: 'a', name: '样稿 A · 工作台同款',
    summary: '浅灰底、白卡片、深色主按钮，和登录后的对话页几乎一样；首屏只有文字，演示在第二屏。',
    review: '设计诊断：最贴近对话页；首屏右半边空，没有产品画面。',
  },
  {
    id: 'b', name: '样稿 B · 白纸大字',
    summary: '纯白底、居中大标题、圆角胶囊按钮，演示窗口放在首屏下方的浅灰带里。',
    review: '设计诊断：大标题层次最强；胶囊按钮和纯白底与对话页不同，像常见 SaaS 模板。',
  },
  {
    id: 'c', name: '样稿 C · 暖色点缀',
    summary: '米白底、主按钮用会员金色、承诺句加暖色划线，推荐价格卡用浅金底。',
    review: '设计诊断：最有吸引力；但金色主按钮和对话页的深色主按钮相反，注册前后按钮含义不一致。',
  },
] as const;

export type PreviewVariantId = (typeof PREVIEW_VARIANTS)[number]['id'];

export function findPreviewVariant(id: string) {
  return PREVIEW_VARIANTS.find(variant => variant.id === id) ?? null;
}
