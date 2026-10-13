/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The public-page style samples for the Owner to choose from (not public; removed after the choice). */
export const PREVIEW_VARIANTS = [
  { id: 'a', name: '样稿 A · 工作台同款', summary: '浅灰底、白卡片、深色主按钮，和登录后的对话页几乎一样；首屏左文右演示。' },
  { id: 'b', name: '样稿 B · 白纸大字', summary: '纯白底、居中大标题、圆角胶囊按钮，演示窗口放在首屏下方的浅灰带里。' },
  { id: 'c', name: '样稿 C · 暖色点缀', summary: '米白底、主按钮用会员金色、承诺句加暖色划线，推荐价格卡用浅金底。' },
] as const;

export type PreviewVariantId = (typeof PREVIEW_VARIANTS)[number]['id'];

export function findPreviewVariant(id: string) {
  return PREVIEW_VARIANTS.find(variant => variant.id === id) ?? null;
}
