/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** What the picker gets from fusionCompare.options (FUSION-COMPARE §3.3, §4). */
export type CompareOptions = { enabled: false; reason: 'disabled' | 'plan' } | { enabled: true;
  models: Array<{ id: string; name: string }>; defaultModelIds: string[]; minModels: number; maxModels: number; usable: boolean };
type Picker = Extract<CompareOptions, { enabled: true }>;

/** Opening the picker: the administrator's default group, limited to models still offered and to the maximum.
 * A default model that is no longer offered is simply not ticked; nothing is picked in its place (§3.3). */
export function initialPick(options: Pick<Picker, 'models' | 'defaultModelIds' | 'maxModels'>): string[] {
  const offered = new Set(options.models.map(model => model.id));
  return options.defaultModelIds.filter(id => offered.has(id)).slice(0, options.maxModels);
}

/** Ticking or unticking one model; ticking past the maximum does nothing (the box is disabled anyway). */
export function togglePick(picked: string[], id: string, maxModels: number): string[] {
  if (picked.includes(id)) return picked.filter(value => value !== id);
  return picked.length >= maxModels ? picked : [...picked, id];
}

/** The line under the picker and whether "开始对比" can be pressed. */
export function pickStatus(picked: string[], options: Pick<Picker, 'minModels' | 'maxModels'>):
  { ready: boolean; hint: string } {
  if (picked.length < options.minModels) return { ready: false, hint: `请再勾选 ${options.minModels - picked.length} 个模型` };
  if (picked.length > options.maxModels) return { ready: false, hint: `最多同时对比 ${options.maxModels} 个模型` };
  return { ready: true, hint: `已选 ${picked.length} 个，最多 ${options.maxModels} 个` };
}

/** Server refusals in plain words (§4 拒绝代号). Unknown codes never show the raw message. */
const REFUSALS: Record<string, string> = {
  FUSION_COMPARE_DISABLED: '多模型对比暂时没有开放。',
  FUSION_COMPARE_FORBIDDEN: '多模型对比是 Gold 会员功能，升级后即可使用。',
  FUSION_MEMBERSHIP_REQUIRED: '多模型对比是 Gold 会员功能，升级后即可使用。',
  FUSION_COMPARE_TOO_FEW: '勾选的模型太少，请再选几个。',
  FUSION_COMPARE_TOO_MANY: '勾选的模型超过了上限，请取消几个。',
  FUSION_COMPARE_MODEL_NOT_ALLOWED: '有模型已经不能用于对比，请重新打开对比再选。',
  FUSION_COMPARE_INPUT_TOO_LARGE: '这次的内容太长，有模型放不下。请缩短问题，或取消勾选放不下的模型后再试。',
  FUSION_BUDGET_EXCEEDED: '这次对比超过了单次上限，请少选几个模型。',
  FUSION_COMPARE_PRICE_CHANGED: '模型价格刚刚有变化，请重新确认预计消耗后再开始。',
  FUSION_COMPARE_ACTIVE: '上一个多模型任务还在进行，结束后再开始新的对比。',
  FUSION_COMPARE_BREAKER: '多模型对比暂时不可用，请稍后再试。',
  FUSION_COMPARE_SESSION_BUSY: '这个对话正在回答上一条消息，等它结束后再开始对比。',
  FUSION_COMPARE_STALE: '对话刚刚有了新内容，请重新开始对比。',
  FUSION_COMPARE_ADOPTED: '这次对比已经采用过一个回答了。',
  FUSION_COMPARE_SESSION_GONE: '这个对话已经删除。',
  FUSION_COMPARE_SKILL_INVALID: '当前使用的技能已经不可用，请重新选择技能。',
  FUSION_COMPARE_REFERENCES_UNSUPPORTED: '多模型对比暂时不能带 @ 引用的资料，请去掉引用后再试。',
  FUSION_COMPARE_REQUEST_CONFLICT: '请求有冲突，请重新开始对比。',
  FUSION_COMPARE_ENDED: '这次对比已经结束。',
  POSITIONING_REQUIRED: '先完成账号定位，再使用这个功能。',
};
export function compareErrorText(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  return REFUSALS[message] ?? '多模型对比暂时出了点问题，请稍后再试。';
}
export const isUpgradeRefusal = (error: unknown) => /FUSION_COMPARE_FORBIDDEN|FUSION_MEMBERSHIP_REQUIRED/
  .test(error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '');

/** One column as the read returns it (fusion_compare_read). */
export type ReadColumn = { column: number; runId: string; modelId: string; body: string | null;
  billing?: { state?: string; reservedCredits?: number | null; chargedCredits?: number | null; closed?: boolean; outcome?: string | null } | null;
  call: { callId: string; state: string; dispatched: boolean; settled?: boolean; verdict: string | null; inFlight?: boolean } | null };
export type ColumnPhase = 'queued' | 'streaming' | 'done' | 'failed' | 'pending' | 'stopped';

/** What a column shows (§3.5, §4.4 three outcomes): an answer, a confirmed failure (free), a result being checked (its hold kept),
 * or stopped. `streaming` is only ever set by the page while its own request runs. */
export function columnPhase(column: ReadColumn, compareState: string): ColumnPhase {
  if (column.call?.verdict === 'usable' || (column.body && column.call?.verdict === null)) return 'done';
  if (column.call?.verdict) return 'failed';
  if (column.billing?.closed) return column.call?.dispatched ? 'failed' : 'stopped';
  if (column.call?.dispatched) return 'pending';
  return compareState === 'stopped' ? 'stopped' : 'queued';
}

/** "待核对，暂时冻结 N 积分" (§4.4): the hold kept for a column whose result is unknown. */
export const heldCredits = (column: ReadColumn) => column.billing?.closed ? 0 : Math.max(0, (column.billing?.reservedCredits ?? 0) - (column.billing?.chargedCredits ?? 0));
export const chargedCredits = (column: ReadColumn) => column.billing?.chargedCredits ?? 0;
