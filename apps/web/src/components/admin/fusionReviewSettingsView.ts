/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';

/** The jury (FUSION-REVIEW) admin form: pure helpers; the server re-validates every save (fusionSettings.update). */
export type FusionSettingsValue = inferRouterOutputs<AppRouter>['fusionSettings']['get'];
export type ReviewSettings = FusionSettingsValue['review'];

export const SEAT_CODES = ['A', 'B', 'C'] as const;
export const NAME_MAX = 20;
/** Credits per review (Owner 2026-10-17: 暂定 1500); the server allows 1–999999. */
export const PRICE_LIMITS = { min: 1, max: 999999 } as const;
export const TOKEN_LIMITS = { opinion: { min: 512, max: 32768 }, summary: { min: 1024, max: 32768 } } as const;

const ERRORS: Record<string, string> = {
  FUSION_REVIEW_INCOMPLETE: '开启评审团前，要选好 3 位评审的模型、汇总模型、评审 Skill，并填写单次评审平台成本保护线。',
  FUSION_REVIEWERS_DUPLICATE: '3 位评审要用 3 个不同的模型。',
  FUSION_REVIEW_CALLS_EXCEEDED: '轮数和评审人数加起来超过单次评审的调用上限。',
  FUSION_PANEL_NAME_INVALID: '评审和汇总的显示名要填，最多 20 个字。',
  FUSION_MODEL_UNAVAILABLE: '选的模型不存在或已停用，请换一个。',
  FUSION_MODEL_SEARCH_DENIED: '评审不能用自带联网搜索的模型，请换一个普通模型。',
  FUSION_MODEL_ADMISSION_REQUIRED: '这个模型还没有准入评审（测试窗口、报价、计费倍数或门槛不完整），开启前要先补齐。',
  FUSION_REVIEW_SKILL_UNAVAILABLE: '选的评审 Skill 没有发布或读不到，请换一个已发布的。',
  FUSION_SETTINGS_INVALID: '有设置不符合要求，请检查后再保存。',
  FUSION_SETTINGS_UNAVAILABLE: '暂时无法读取或保存评审团设置，请稍后再试。',
};
const WARNINGS: Record<string, string> = {
  FUSION_REVIEWERS_SAME_PROVIDER: '已保存。提示：3 位评审都是同一家公司的模型，换不同公司的模型，意见通常更多样。',
};

const codeOf = (error: unknown) => (error && typeof error === 'object' && 'message' in error ? String(error.message) : '');
/** Plain words for a refused save; never the raw code or server text. */
export const settingsErrorText = (error: unknown) => {
  const code = codeOf(error);
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : /^FUSION_REVIEW_SKILL/.test(code) ? ERRORS.FUSION_REVIEW_SKILL_UNAVAILABLE
    : ERRORS.FUSION_SETTINGS_UNAVAILABLE;
};
export const warningText = (code: string) => WARNINGS[code] ?? '已保存。';

/** Problems the form can see before asking the server; an empty list does not mean the server will accept. */
export function draftProblems(review: ReviewSettings): string[] {
  const problems: string[] = [];
  const names = [...review.displayNames.reviewers, review.displayNames.summary];
  if (names.some(name => { const length = [...name.trim()].length; return length < 1 || length > NAME_MAX; })) problems.push(ERRORS.FUSION_PANEL_NAME_INVALID);
  const picked = review.reviewerModelIds.filter(Boolean);
  if (new Set(picked).size !== picked.length) problems.push(ERRORS.FUSION_REVIEWERS_DUPLICATE);
  const tokens = (value: number, limit: { min: number; max: number }) => Number.isInteger(value) && value >= limit.min && value <= limit.max;
  if (!tokens(review.opinionOutputTokens, TOKEN_LIMITS.opinion)) {
    problems.push(`每位评审的意见长度要在 ${TOKEN_LIMITS.opinion.min}–${TOKEN_LIMITS.opinion.max} 之间。`);
  }
  if (!tokens(review.summaryOutputTokens, TOKEN_LIMITS.summary)) {
    problems.push(`汇总的输出长度要在 ${TOKEN_LIMITS.summary.min}–${TOKEN_LIMITS.summary.max} 之间。`);
  }
  const budget = review.maxBudgetUsd?.trim() ?? '';
  if (budget && (!/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(budget) || Number(budget) <= 0)) {
    problems.push('平台成本保护线要填大于 0 的美元金额，例如 5。');
  }
  const price = review.fixedPriceCredits;
  if (!Number.isInteger(price) || price < PRICE_LIMITS.min || price > PRICE_LIMITS.max) {
    problems.push(`每次评审的价格要是 ${PRICE_LIMITS.min}–${PRICE_LIMITS.max} 之间的整数积分。`);
  }
  if (review.enabled && (picked.length !== SEAT_CODES.length || !review.summaryModelId || !review.skillId || !review.maxBudgetUsd)) {
    problems.push(ERRORS.FUSION_REVIEW_INCOMPLETE);
  }
  return problems;
}

/** The saved value with the form's text trimmed and empty seats dropped, as the server expects. */
export function toSaved(value: FusionSettingsValue, review: ReviewSettings): FusionSettingsValue {
  return { ...value, review: { ...review, reviewerModelIds: review.reviewerModelIds.filter(Boolean),
    maxBudgetUsd: review.maxBudgetUsd?.trim() ? review.maxBudgetUsd.trim() : null,
    displayNames: { reviewers: review.displayNames.reviewers.map(name => name.trim()), summary: review.displayNames.summary.trim() } } };
}

/** Changes that make the later rounds of a running review fail: turning the jury off, or another model or Skill. */
export function affectsRunning(saved: ReviewSettings, next: ReviewSettings): boolean {
  return saved.enabled && !next.enabled || saved.summaryModelId !== next.summaryModelId || saved.skillId !== next.skillId
    || saved.reviewerModelIds.join() !== next.reviewerModelIds.filter(Boolean).join();
}

/** Reviews still running or paused in one page of the administrator look-back list (fusionSettings.reviews). */
export function runningCount(list: unknown): number {
  return Array.isArray(list) ? list.filter(item => ['running', 'paused'].includes(String((item as { state?: unknown }).state))).length : 0;
}

type Cursor = { createdAt: string; reviewId: string };
export const REVIEW_PAGE = 100;
/** Every running or paused review, walking the whole look-back list page by page (newest first, keyset): an older
 * paused review behind many finished ones still counts. Stops at maxPages; the count is then a lower bound. */
export async function countRunning(page: (before?: Cursor) => Promise<unknown>, maxPages = 50): Promise<number> {
  let total = 0;
  let before: Cursor | undefined;
  for (let at = 0; at < maxPages; at++) {
    const rows = await page(before);
    if (!Array.isArray(rows)) return total;
    total += runningCount(rows);
    const last = rows[rows.length - 1] as Partial<Cursor> | undefined;
    if (rows.length < REVIEW_PAGE || !last?.createdAt || !last.reviewId) return total;
    before = { createdAt: last.createdAt, reviewId: last.reviewId };
  }
  return total;
}

/** Every Skill, following skills.list's pages of 50 until its total. */
export async function allSkills<T>(page: (offset: number) => Promise<{ skills: T[]; total: number }>, maxPages = 40): Promise<T[]> {
  const all: T[] = [];
  for (let at = 0; at < maxPages; at++) {
    const { skills, total } = await page(all.length);
    all.push(...skills);
    if (!skills.length || all.length >= total) break;
  }
  return all;
}
