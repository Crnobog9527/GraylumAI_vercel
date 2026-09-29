import { getErrorMessageText } from '@/lib/safe-error-message';

export type AccountErasurePreview = {
  credits: number;
  subscriptionRenewing: boolean;
  subscriptionActiveUntil: string | null;
  pendingPayments: number;
  runsInFlight: number;
  closed: boolean;
};

export type ImpactLine = { tone: 'block' | 'warn' | 'info'; text: string };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Factual placeholder copy (DATA-ERASURE §1, §8, E1/E2/E4/E5/E11); the Owner may replace wording. */
export function buildErasureImpactLines(preview: AccountErasurePreview): ImpactLine[] {
  const lines: ImpactLine[] = [];
  if (preview.subscriptionRenewing) {
    lines.push({ tone: 'block', text: '你有自动续费的订阅，需先在订阅管理中取消自动续费，才能申请注销。' });
  }
  lines.push({ tone: 'warn', text: '确认后账号立即关闭，不能再登录或使用，也不能撤销；没有冷静期和回收站。' });
  lines.push({ tone: 'warn', text: `剩余 ${preview.credits} 积分将作废，不能再使用。` });
  if (preview.subscriptionActiveUntil) {
    const until = formatDate(preview.subscriptionActiveUntil);
    lines.push({ tone: 'warn', text: `订阅原本有效至 ${until}，剩余权益随注销失效。` });
  }
  lines.push({ tone: 'info', text: '已付费的订阅和积分包默认不退款；如有特殊情况，请在注销前联系客服。' });
  lines.push({ tone: 'info', text: '对话、定位、稿件等私有内容将被清除；已下载到本机或发给他人的副本不在清除范围内。' });
  lines.push({
    tone: 'info',
    text: '金额、订单编号和时间等账务记录保留至交易年度结束后 3 年，只用于对账，不能用于恢复账号。',
  });
  if (preview.pendingPayments > 0) {
    lines.push({ tone: 'info', text: `有 ${preview.pendingPayments} 笔付款仍在处理，处理完成后注销才会最终完成。` });
  }
  if (preview.runsInFlight > 0) {
    lines.push({ tone: 'info', text: `有 ${preview.runsInFlight} 个 AI 任务仍在结算，结算完成后注销才会最终完成。` });
  }
  return lines;
}

const ERROR_TEXT: Array<[string, string]> = [
  ['ACCOUNT_ERASURE_REAUTH_REQUIRED', '身份验证已过期，请重新验证后再确认注销。'],
  ['ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING', '你有自动续费的订阅，请先取消自动续费再申请注销。'],
  ['ACCOUNT_ERASURE_ADMIN_DENIED', '管理员账号需先取消管理员权限才能注销。'],
  ['ACCOUNT_ERASURE_STATUS_DENIED', '当前账号状态不能申请注销，请联系客服。'],
  ['ACCOUNT_CLOSED', '账号已注销。'],
];

export function describeErasureError(error: unknown): string {
  const message = getErrorMessageText(error);
  const known = ERROR_TEXT.find(([code]) => message.includes(code));
  if (known) {
    return known[1];
  }
  if ((error as { data?: { code?: string } } | null)?.data?.code === 'TOO_MANY_REQUESTS') {
    return '操作太频繁，请稍后再试。';
  }
  return '注销暂时无法完成，请稍后重试。';
}

export function isAccountClosedError(error: unknown): boolean {
  return getErrorMessageText(error).includes('ACCOUNT_CLOSED');
}
