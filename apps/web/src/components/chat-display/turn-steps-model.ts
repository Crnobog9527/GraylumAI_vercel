/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Long-task step status (Owner 2026-10-18): one turn is shown as a few small steps instead of one long "生成中".
// Pure functions only. Inputs come from the existing stream (phase, text, research calls, work items); no new data.

export type StepState = 'done' | 'running' | 'waiting';
export interface TurnStep { id: 'tools' | 'write' | 'organize' | 'save'; state: StepState; label: string }
export interface ToolCounts { running: number; done: number; failed: number; pending?: number }

export interface TurnProgressInput {
  /** The live phase: mentor | reading | organizer | saving. Anything else counts as mentor. */
  phase: string;
  /** Some reply text has already arrived. */
  hasText: boolean;
  tools: ToolCounts;
}

const EMPTY: ToolCounts = { running: 0, done: 0, failed: 0 };

/** Counts research calls and work rows by how they ended. `pending`/`unknown` (result still being verified) are kept apart. */
export function toolCounts(states: readonly string[]): ToolCounts {
  const counts = { ...EMPTY };
  for (const state of states) {
    if (state === 'running') counts.running++;
    else if (state === 'failed' || state === 'missing') counts.failed++;
    else if (state === 'pending' || state === 'unknown') counts.pending = (counts.pending ?? 0) + 1;
    else counts.done++;
  }
  return counts;
}

/** The small steps of one turn, in order. Only steps that apply to this turn are listed. */
export function turnSteps({ phase, hasText, tools }: TurnProgressInput): TurnStep[] {
  const steps: TurnStep[] = [];
  const pending = tools.pending ?? 0;
  const total = tools.running + tools.done + tools.failed + pending;
  const later = phase === 'organizer' || phase === 'saving';
  if (total > 0) {
    const finished = tools.done + tools.failed + pending;
    steps.push(tools.running > 0
      ? { id: 'tools', state: 'running', label: `正在查资料和数据（已完成 ${finished}/${total}）…` }
      : { id: 'tools', state: 'done',
        label: `查资料和数据：完成 ${tools.done} 项` + (tools.failed ? `，${tools.failed} 项这次没查到` : '')
          + (pending ? `，${pending} 项待核对` : '') });
  }
  if (later) steps.push({ id: 'write', state: 'done', label: '回复已写完' });
  else if (hasText) steps.push({ id: 'write', state: 'running', label: '正在写回复…' });
  else if (tools.running > 0) steps.push({ id: 'write', state: 'waiting', label: '查完资料后开始写回复' });
  else steps.push({ id: 'write', state: 'running', label: total > 0 ? '正在根据查到的内容写回复…' : '正在想怎么回复…' });
  if (phase === 'organizer') steps.push({ id: 'organize', state: 'running', label: '正在整理待核对信息…' });
  if (phase === 'saving') {
    steps.push({ id: 'save', state: 'running', label: '正在保存结果、核对费用…' });
  }
  return steps;
}

export const SLOW_AFTER_MS = 20_000;
export const VERY_SLOW_AFTER_MS = 120_000;

/** A reassurance line for a turn that takes long; null while it is still quick. */
export function slowHint(elapsedMs: number): string | null {
  if (elapsedMs < SLOW_AFTER_MS) return null;
  if (elapsedMs < VERY_SLOW_AFTER_MS) return '这一轮需要一点时间，还在正常处理。请先别刷新页面，写完会自动显示。';
  return '比平时久一些，仍在处理。刷新页面会暂时看不到实时进度，请再等一会儿，写完会自动显示。';
}

export const REOPENED_HINT = '这一轮还在后台处理，写完会自动显示在这里，不用重发。';
