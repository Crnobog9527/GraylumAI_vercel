/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * NEW (Owner 2026-10-17): sample L's region 4, the sample reports, redone from the visitor's side. The people in the
 * reports are fictional, so they are never called 用户案例; each card and the dialog carry one small grey 「示例」 tag
 * instead of the long "由 Graylum 定位 Skill 生成，人物为虚构" line. The coach's warning is 「方向已调整」 on a card and
 * 「风险提醒」 in the dialog. Samples M, N and O keep L_SAMPLES (landing-copy-l.ts).
 */
export const L_SAMPLES_REDO = {
  /** NEW */
  title: '找到和你情况一样的人',
  /** NEW: under the title; the count and its measure word never part (the gap before the count is drawn). */
  ledeParts: (count: number) => ['这里有', `${count} 种人`, '拿到的完整报告，点开任意一张看'] as const,
  lede: (count: number) => `这里有 ${count} 种人拿到的完整报告，点开任意一张看`,
  /** NEW: one small grey tag on every card and in the dialog. */
  sample: '示例',
  /** NEW: the card's tag when the coach changed the person's direction. */
  adjusted: '方向已调整',
  open: '看这份报告',
  pause: '移到卡片上会停下',
  swipe: '左右滑动看更多',
  close: '关闭',
  /** NEW: the 10-second card, read top to bottom. */
  glance: {
    title: '10 秒看懂',
    risk: '风险提醒',
    who: '你是谁',
    money: '怎么赚钱',
    first: '这周第一步',
  },
} as const;
