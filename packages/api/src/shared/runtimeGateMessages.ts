/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export const runtimeGateMessages = {
  minute: '操作过于频繁，请稍后再试。本次被拦截的调用不扣积分。',
  day: '近24小时使用次数已达上限，请稍后再试。本次被拦截的调用不扣积分。',
  paused: 'AI服务暂时暂停新调用，请稍后再试。本次被拦截的调用不扣积分。',
  limit_unavailable: '暂时无法确认使用额度，请稍后再试。本次被拦截的调用不扣积分。',
} as const;
export type RuntimeGateMessage = keyof typeof runtimeGateMessages;
