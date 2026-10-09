/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** REPORT-MODEL admin view helpers (docs/launch/tasks/REPORT-MODEL.md); the server validates every save. */
export const FOLLOW_DIALOGUE = '';

const ERRORS: Record<string, string> = {
  REPORT_MODEL_UNAVAILABLE: '这个模型不存在、已停用，或者不支持写报告，请换一个。',
  REPORT_MODEL_PRICING_UNAVAILABLE: '这个模型的报价缺失或已过期，暂时不能用来写报告。',
  REPORT_MODEL_ADMISSION_REQUIRED: '这个模型还没有准入写报告（测试窗口、报告配置、计费倍数或门槛不完整）。',
  REPORT_MODEL_CONFIG_UNAVAILABLE: '暂时无法读取或保存报告模型设置，请稍后再试。',
  REPORT_MODULE_NOT_FOUND: '找不到这个功能模块，可能已被删除，请刷新页面。',
  REPORT_MODEL_CONFLICT: '这个设置刚被其他人改过。请点“重新读取”看最新设置，再决定是否保存。',
};

/** Plain text for the stable REPORT-MODEL codes; never the raw code or server text. */
export function reportModelErrorText(error: unknown) {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS.REPORT_MODEL_CONFIG_UNAVAILABLE;
}

export function isReportModelConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'message' in error && error.message === 'REPORT_MODEL_CONFLICT');
}

type Named = { id: string; name: string };

/** A model's display name; an id the lists do not know is shown as such, never as a guess. */
export function modelLabel(id: string | null | undefined, ...lists: Array<readonly Named[] | undefined>) {
  if (!id) return '未设置';
  for (const list of lists) {
    const found = list?.find(model => model.id === id);
    if (found) return found.name;
  }
  return `未知模型（${id.slice(0, 8)}）`;
}

/** Selectable report models: the eligible list, plus the saved one marked unavailable if it dropped out. */
export function reportModelChoices(options: readonly Named[], saved: string | null, names: readonly Named[] | undefined) {
  const choices = options.map(model => ({ id: model.id, name: model.name, disabled: false }));
  if (saved && !options.some(model => model.id === saved)) {
    choices.push({ id: saved, name: `${modelLabel(saved, names)}（当前不可选）`, disabled: true });
  }
  return choices;
}
