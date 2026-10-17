/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * EXPERT-CONSULT copy (Master Plan 2.1 item 51, records L/Q/R). The card says "预约咨询，免费询价" and never
 * a price; there is no "let the expert see my report" switch — materials are exported by the user later.
 */
export const EXPERT_CONSULT_SOURCES = ['report', 'pricing', 'studio'] as const;
export type ExpertConsultSource = (typeof EXPERT_CONSULT_SOURCES)[number];
export const isExpertConsultSource = (value: string | null | undefined): value is ExpertConsultSource =>
  EXPERT_CONSULT_SOURCES.includes(value as ExpertConsultSource);
export const expertConsultPath = (source: ExpertConsultSource) => `/expert-consult?from=${source}`;

export const NEED_MIN = 10;
export const NEED_MAX = 2000;
export const CONTACT_MIN = 3;
export const CONTACT_MAX = 200;

export const EXPERT_CONSULT_COPY = {
  cardTitle: '真人专家诊断',
  cardLede: '线上一对一，帮你看账号定位和下一步怎么做。适合已经完成账号定位的用户。',
  cta: '预约咨询，免费询价',
  pageTitle: '预约真人专家诊断',
  pageLede: '写下你想解决的问题和联系方式，我们会尽快联系你，沟通时间和报价。',
  needLabel: '你想解决什么问题',
  needPlaceholder: '例如：账号做了两个月，播放一直上不去，想知道定位和内容方向哪里需要调整。',
  contactLabel: '怎么联系你',
  contactPlaceholder: '邮箱、微信或电话，任选一个',
  privacy: '联系方式只用于这次预约，注销账号时会一起删除。请不要填写密码等敏感信息；需要的资料，我们联系你之后由你自己导出发来。',
  submit: '提交预约',
  submitting: '正在提交…',
  sentTitle: '已收到你的预约',
  sentText: '我们会通过你留下的联系方式联系你。处理进度可以在个人中心的工单里查看。',
  tickets: '查看工单',
  notEligibleTitle: '完成一次账号定位后就可以预约',
  notEligibleText: '专家诊断需要先有你的账号定位作为基础。完成定位后再回到这里预约。',
  startPositioning: '去做账号定位',
  loadFailed: '暂时无法打开预约，请稍后再试。',
} as const;

const ERRORS: Record<string, string> = {
  EXPERT_CONSULT_NOT_ELIGIBLE: EXPERT_CONSULT_COPY.notEligibleTitle,
  EXPERT_CONSULT_INVALID: `请把问题写得具体一些（${NEED_MIN}–${NEED_MAX} 字），并留下联系方式（${CONTACT_MIN}–${CONTACT_MAX} 字）。`,
  EXPERT_CONSULT_ACCOUNT_CLOSED: '这个账号当前不能提交预约。',
};
/** Server codes only; anything else (including raw errors) gets the generic text. */
export const expertConsultErrorText = (code: string | null | undefined) =>
  (code && ERRORS[code]) || '提交没有成功，请稍后再试。';
