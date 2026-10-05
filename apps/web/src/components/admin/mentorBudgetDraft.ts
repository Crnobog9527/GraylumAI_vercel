/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';
import { getSafeErrorMessage } from '@/lib/safe-error-message';

export type BudgetView = inferRouterOutputs<AppRouter>['mentorBudget']['get'];
export type BudgetInput = inferRouterInputs<AppRouter>['mentorBudget']['update'];
export type BudgetPurpose = 'interactive' | 'organize' | 'report';
/** Editable per purpose. The answer length is the site-wide output cap, shown read-only (CHAT-NATIVE-OUTPUT §3.2). */
export type BudgetField = 'inputBytes' | 'historyItems';

/** Form state keeps raw text so a half-typed number is not silently rewritten. */
export type BudgetDraft = Record<BudgetPurpose, Record<BudgetField, string>>;

// Mirrors the server schema's lower bound; limits.inputBytes only carries the upper caps.
export const MIN_INPUT_BYTES = 1024;
export const BUDGET_PURPOSES: BudgetPurpose[] = ['interactive', 'organize', 'report'];
export const PURPOSE_TITLES: Record<BudgetPurpose, string> = {
  interactive: '交互对话',
  organize: '整理',
  report: '报告（预留）',
};
export const FIELD_LABELS: Record<BudgetField, string> = {
  inputBytes: '输入上限（字节）',
  historyItems: '历史条数上限',
};
/** Validation messages from an older form may still name the retired output field. */
const LEGACY_FIELD_LABELS: Record<string, string> = { ...FIELD_LABELS, maxOutputTokens: '回答上限（token）' };

export const BUDGET_FIELDS: BudgetField[] = ['inputBytes', 'historyItems'];

/** Configured values when present; an unconfigured budget starts empty instead of inventing defaults. */
export function toBudgetDraft(view: BudgetView): BudgetDraft {
  const text = (value: number | undefined) => (value === undefined ? '' : String(value));
  const config = view.config;
  const fields = (purpose: BudgetPurpose) => ({
    inputBytes: text(config?.[purpose].inputBytes), historyItems: text(config?.[purpose].historyItems),
  });
  return { interactive: fields('interactive'), organize: fields('organize'), report: fields('report') };
}

export function fieldRange(view: BudgetView, purpose: BudgetPurpose, field: BudgetField): [number, number] {
  if (field === 'inputBytes') return [MIN_INPUT_BYTES, view.limits.inputBytes[purpose]];
  return [0, view.limits.historyItems];
}

export function fieldUnit(field: BudgetField): string {
  return field === 'inputBytes' ? '字节' : '条';
}

function draftValue(draft: BudgetDraft, purpose: BudgetPurpose, field: BudgetField): string {
  return draft[purpose][field] ?? '';
}

/** Front-end pre-check only; the server schema stays the final authority. */
export function fieldProblem(view: BudgetView, draft: BudgetDraft, purpose: BudgetPurpose, field: BudgetField): string | null {
  const raw = draftValue(draft, purpose, field).trim();
  if (!raw) return '请填写';
  if (!/^\d+$/.test(raw)) return '请填写不带小数的非负整数';
  const value = Number(raw);
  const [min, max] = fieldRange(view, purpose, field);
  const unit = fieldUnit(field);
  if (value < min) return `不能小于 ${min} ${unit}`;
  if (value > max) return `不能超过系统上限 ${max} ${unit}`;
  return null;
}

export function draftProblems(view: BudgetView, draft: BudgetDraft): string[] {
  const problems: string[] = [];
  for (const purpose of BUDGET_PURPOSES) {
    for (const field of BUDGET_FIELDS) {
      const problem = fieldProblem(view, draft, purpose, field);
      if (problem) problems.push(`${PURPOSE_TITLES[purpose]} · ${FIELD_LABELS[field]}：${problem}`);
    }
  }
  return problems;
}

/**
 * The complete strict object the update procedure accepts. The server still
 * stores the version 1 shape for rollback; its output fields carry the
 * site-wide cap (`view.limits.maxOutputTokens`) and are ignored on admission.
 */
export function toBudgetInput(draft: BudgetDraft, outputCap: number): BudgetInput {
  const n = (value: string) => Number(value.trim());
  const fields = (purpose: BudgetPurpose) => ({
    inputBytes: n(draft[purpose].inputBytes), historyItems: n(draft[purpose].historyItems),
  });
  return {
    version: 1,
    interactive: { ...fields('interactive'), maxOutputTokens: outputCap },
    organize: fields('organize'),
    report: { ...fields('report'), maxOutputTokens: outputCap },
  };
}

type Issue = { code?: string; path?: unknown[]; maximum?: unknown; minimum?: unknown; expected?: unknown; keys?: unknown[] };

function issuePlace(path: unknown[] | undefined): string {
  const [purpose, field] = path ?? [];
  const title = PURPOSE_TITLES[purpose as BudgetPurpose];
  const label = LEGACY_FIELD_LABELS[field as string];
  if (title && label) return `${title} · ${label}`;
  if (title) return title;
  return path && path.length ? path.join('.') : '预算配置';
}

function issueReason(issue: Issue): string {
  switch (issue.code) {
    case 'too_big': return `不能超过 ${issue.maximum}`;
    case 'too_small': return `不能小于 ${issue.minimum}`;
    case 'invalid_type': return issue.expected === 'int' ? '必须是整数' : '缺少或格式不对';
    case 'unrecognized_keys': return `包含不支持的字段：${(issue.keys ?? []).join('、')}`;
    case 'invalid_value': return '取值不被接受';
    default: return '不符合要求';
  }
}

/** Server input-validation issues are JSON; show each one in Chinese. */
export function translateValidationMessage(message: string): string | null {
  let issues: unknown;
  try { issues = JSON.parse(message); } catch { return null; }
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return (issues as Issue[]).map(issue => `${issuePlace(issue.path)}：${issueReason(issue)}`).join('；');
}

export function budgetErrorMessage(error: { message: string; data?: { code?: string } | null }, fallback: string): string {
  if (error.data?.code === 'BAD_REQUEST') {
    const translated = translateValidationMessage(error.message);
    if (translated) return `服务端拒绝保存：${translated}`;
  }
  return getSafeErrorMessage(error, fallback);
}

/** Chinese reading of the server's legacy description; unknown wording is shown as-is. */
export function describeLegacy(view: BudgetView): string[] {
  const { interactive, organize, report } = view.legacy;
  const realOutput = interactive.realOutput === 'min(approved quote, model, global output cap)'
    ? '取“批准报价输出上限、模型输出上限、全站统一上限”三者中最小的' : interactive.realOutput;
  return [
    `交互对话：输入上限 ${interactive.inputBytes} 字节，历史 ${interactive.historyItems} 条；`
      + `回答上限${realOutput} token（测试替身固定 ${interactive.fixtureMaxOutputTokens} token）。`,
    `整理：不带历史（${organize.historyItems} 条），回答上限来自整理模型回复长度设置。`,
    `报告：${report.active ? '已启用' : '尚未启用'}。`,
  ];
}
