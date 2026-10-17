/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the PAY-NOTIFY admin page (payment notices that need a person).

export interface PaymentNoticeItem {
  id: string;
  kind: string;
  state: 'sending' | 'failed' | 'unknown' | 'manual';
  manualReason: 'unknown_unresolved' | 'unknown_expired' | 'digest_mismatch' | null;
  attempts: number;
  lastErrorCode: string | null;
  userEmail: string | null;
  createdAt: string;
  firstAttemptAt: string | null;
  resendable: boolean;
}

export const KIND_LABEL: Record<string, string> = {
  card_renewal_upcoming: '银行卡年付扣款前提醒',
  wallet_founder_expiry: '创始会员到期提醒（微信/支付宝）',
  wallet_plan_expiry: '1 年会员到期提醒（微信/支付宝）',
  restore_pro_expiry: '恢复的 Pro 即将到期',
  dispute_won_resubscribe: '拒付判赢后重新订阅',
  founder_ended: '创始身份已结束',
};

export function stateLabel(item: PaymentNoticeItem) {
  if (item.state === 'manual') {
    if (item.manualReason === 'digest_mismatch') return '转人工：两次发送之间收件邮箱或内容变了，不能用原来的编号重发';
    if (item.manualReason === 'unknown_expired') return '转人工：结果不确定且已超过 24 小时，请到 Resend 后台核对是否送达';
    return '转人工：发送结果不确定（可能已送达）';
  }
  if (item.state === 'unknown') return '发送结果不确定（可能已送达）';
  if (item.state === 'sending') return '正在发送';
  return item.attempts >= 3 ? '发送失败（已试 3 次，不再自动重试）' : '发送失败（下次定时任务会重试）';
}

export const RESEND_NOTE = '用同一个发送编号重新发送：如果上一次其实已经送达，邮件服务不会再发第二封。'
  + '只在第一次发送后 24 小时内可用。';

type ErrorLike = { data?: { code?: string } | null; message?: string } | null | undefined;

export function paymentNoticeError(error: ErrorLike, action: 'read' | 'resend') {
  const code = error?.data?.code;
  const message = error?.message ?? '';
  if (code === 'FORBIDDEN') return '当前账号无权操作。';
  if (message === 'PAYMENT_NOTICE_NOT_CONFIGURED') return '还没有在"第三方密钥"页填写 Resend 密钥，暂时不能发送。';
  if (message === 'PAYMENT_NOTICE_TEST_RECIPIENTS_MISSING') return '测试环境没有设置测试收件邮箱，暂时不能发送。';
  if (message === 'PAYMENT_NOTICE_RECIPIENT_NOT_ALLOWED') return '测试环境只能发到测试收件邮箱，这位用户不在名单里。';
  if (message === 'PAYMENT_NOTICE_NO_RECIPIENT') return '这位用户没有登录邮箱，无法发送。';
  if (message === 'PAYMENT_NOTICE_TEMPLATE_MISSING') return '这类提醒的邮件模板还没有上线，暂时不能发送。';
  if (message === 'PAYMENT_NOTICE_NOT_RESENDABLE') return '这条记录已经不能重发（已处理或超过 24 小时），已重新读取。';
  if (action === 'read') return '暂时无法读取发送记录，请稍后重试。';
  return '重新发送失败，请稍后再试。';
}

export function resendOutcomeLabel(outcome: string) {
  if (outcome === 'sent') return '已发送。';
  if (outcome === 'failed') return '邮件服务拒绝了这次发送，原因已记录。';
  if (outcome === 'skipped') return '用户账号正在注销，已跳过。';
  if (outcome === 'busy') return '另一次发送正在进行，请稍后刷新。';
  return '结果仍不确定，记录已保留，可在 24 小时内再试。';
}
