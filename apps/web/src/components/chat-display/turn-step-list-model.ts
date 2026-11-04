import type { StepEvent, StepKind, StepState } from '@repo/api/src/services/turn/sse';

/*
 * The steps of one reply (a Skill read, a search, a library or data read), as the stream sends them and as a reload shows them.
 * Pure functions only. A step holds only a kind, a state, a Skill's public name, a short detail and a count: no argument,
 * result or Skill text ever reaches the page, so a saved step can hold nothing more.
 */
export type ReplyStepKind = StepKind | 'think';
export type ReplyStep = { id: string; tool: ReplyStepKind; state: StepState; label?: string; detail?: string; count?: number; reason?: 'no_brand' };

export const THINKING_STEP: ReplyStep = { id: 'think', tool: 'think', state: 'running' };

/** The step an event describes, in place of the step with the same id (a running step becomes its end), else added last. */
export function mergeStep(steps: readonly ReplyStep[], event: Pick<StepEvent, 'id' | 'tool' | 'state' | 'label' | 'detail' | 'count' | 'reason'>): ReplyStep[] {
  const next: ReplyStep = { id: event.id, tool: event.tool, state: event.state,
    ...(event.label ? { label: event.label } : {}), ...(event.detail ? { detail: event.detail } : {}),
    ...(event.count !== undefined ? { count: event.count } : {}), ...(event.reason ? { reason: event.reason } : {}) };
  return steps.some(step => step.id === event.id) ? steps.map(step => step.id === event.id ? next : step) : [...steps, next];
}

const quoted = (label?: string) => label ? `「${label}」` : '';

/** The one line of a step. Neutral words: a step that did not work says what happens instead, not "error". */
export function stepLine(step: ReplyStep): string {
  const { tool, state, label, detail, count } = step;
  if (tool === 'think') return label || '正在思考…';
  if (state === 'running') {
    switch (tool) {
      case 'load_skill': return label ? `正在读取${quoted(label)}方法…` : '正在读取方法…';
      case 'research': return detail ? `正在联网搜索：${detail}…` : '正在联网搜索…';
      case 'read_source': return '正在查阅资料库…';
      case 'coach_review': return '正在读取你的作品数据…';
      default: return '正在处理…';
    }
  }
  if (state === 'done') {
    switch (tool) {
      case 'load_skill': return label ? `已读取${quoted(label)}方法` : '已读取方法';
      case 'research': return count === undefined ? '已搜索' : count > 0 ? `已搜索，找到 ${count} 条结果` : '已搜索，没有找到结果';
      case 'read_source': return count === undefined ? '已查阅资料库' : count > 0 ? `已查阅资料库，找到 ${count} 条相关内容` : '已查阅资料库，没有相关内容';
      case 'coach_review': return '已读取你的作品数据';
      default: return '已处理';
    }
  }
  if (state === 'failed') {
    switch (tool) {
      case 'load_skill': return `${label ? quoted(label) : ''}方法暂时读取不了，改为直接回答`;
      case 'research': return '联网搜索暂时没成功，改用已有信息回答';
      case 'read_source': return '资料库暂时读取不了，改为直接回答';
      case 'coach_review': return '作品数据暂时读取不了，改为直接回答';
      default: return '这一步没有完成，改为直接回答';
    }
  }
  if (tool === 'coach_review' && step.reason === 'no_brand') return '还没连接作品账号，这次按定位和资料回答';
  switch (tool) {
    case 'load_skill': return '这次没有使用该方法';
    case 'research': return '这次没有联网搜索';
    case 'read_source': return '这次没有查阅资料库';
    case 'coach_review': return '这次没有读取作品数据';
    default: return '这一步这次没有用到';
  }
}

export const stepsRunning = (steps: readonly ReplyStep[]) => steps.some(step => step.state === 'running');

/** The folded row: how many steps ended, and how many of them did not work. */
export function stepsSummary(steps: readonly ReplyStep[]): string {
  const ended = steps.filter(step => step.state !== 'running' && step.tool !== 'think');
  const failed = ended.filter(step => step.state === 'failed').length;
  return `已完成 ${ended.length} 个步骤${failed ? `，其中 ${failed} 个没成功` : ''}`;
}

/** What the list shows. While the reply is live and nothing is running or written yet, the reply is "thinking". */
export function visibleSteps(steps: readonly ReplyStep[], live: boolean, hasText: boolean): ReplyStep[] {
  return live && !hasText && !stepsRunning(steps) ? [...steps, THINKING_STEP] : [...steps];
}

/** Open while the reply has nothing written yet or a step runs; folded once the text flows or the reply ended, unless the reader chose. */
export function stepsOpen(steps: readonly ReplyStep[], live: boolean, hasText: boolean, chosen: boolean | null): boolean {
  if (live && (!hasText || stepsRunning(steps))) return true;
  return chosen ?? false;
}
