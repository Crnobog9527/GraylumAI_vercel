/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ImageStepReason } from '@repo/api/src/services/turn/sse';

/*
 * INTEGRATION-SHOTVIVA: what an image card says when an image was not made (or is still being made), and the one button that
 * helps, in plain words. Codes come from the Shotviva partner contract and the image tool; anything else reads as the generic
 * line. 2026-11-07 Owner requirement (IMAGE-GEN-PLAN): IDENTITY_SWAP_REFUSED says 不支持换脸, charges nothing, is not retried.
 */
export type ImageCardAction = { kind: 'connect' | 'upgrade' | 'top_up' | 'view'; label: string };
export type ImageCardMessage = { text: string; action?: ImageCardAction };

const CONNECT: ImageCardAction = { kind: 'connect', label: '去连接 Shotviva' };
const UPGRADE: ImageCardAction = { kind: 'upgrade', label: '查看会员' };
const TOP_UP: ImageCardAction = { kind: 'top_up', label: '去 Shotviva 充值' };
const VIEW: ImageCardAction = { kind: 'view', label: '在 Shotviva 查看' };

const MESSAGES: Record<ImageStepReason, ImageCardMessage> = {
  running: { text: '图片还在生成，稍后会出现在这里，也可以到 Shotviva「我的作品」里查看。', action: VIEW },
  not_linked: { text: '还没有连接 Shotviva 账号，连接后就能在对话里直接生成图片。', action: CONNECT },
  membership_required: { text: '在对话里生成图片是 Pro 和 Gold 会员的功能。', action: UPGRADE },
  quota_exhausted: { text: 'Shotviva 的生图额度用完了，充值后就能继续生成。', action: TOP_UP },
  IDENTITY_SWAP_REFUSED: { text: '不支持换脸，也不能把人物换成真实的某个人。这次没有生成，也没有扣 Shotviva 积分。' },
  content_rejected: { text: '这张图的内容没有通过图片模型的安全检查，没有生成，也没有扣 Shotviva 积分。换个描述再试试。' },
  invalid_input: { text: '图片的要求不完整或不符合模板，换个说法再试一次。' },
  rate_limited: { text: '生成得太频繁了，过几分钟再试。' },
  generation_failed: { text: '这次没有生成成功，Shotviva 已退回积分，可以再试一次。' },
  link_revoked: { text: '你在 Shotviva 那边断开了和 Graylum 的连接，需要重新连接。', action: CONNECT },
  unavailable: { text: 'Shotviva 暂时连接不上，这次没有生成图片，稍后再试。' },
};

export function imageCardMessage(reason: string | undefined): ImageCardMessage {
  return reason && Object.hasOwn(MESSAGES, reason) ? MESSAGES[reason as ImageStepReason] : MESSAGES.unavailable;
}

/** Where a card's button goes: the integrations page to connect, the membership page, Shotviva's own top-up or job page. */
export function imageActionHref(action: ImageCardAction, links: { topUpUrl?: string | null; viewUrl?: string | null }): string | null {
  switch (action.kind) {
    case 'connect': return '/app/integrations';
    case 'upgrade': return '/app/profile?tab=subscription';
    case 'top_up': return links.topUpUrl ?? '/app/integrations';
    case 'view': return links.viewUrl ?? null;
  }
}
