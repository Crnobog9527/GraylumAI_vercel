import type { ToolStageEvent } from '@repo/api/src/services/turn/sse';

/*
 * What the waiting reply says while the model is working through a tool instead of writing: the server names only the kind of
 * tool (and a Skill's public name), the words are the page's. The line goes away by itself once the text starts (the reply shows
 * the text instead), so nothing here has to be cleared.
 */
export type ToolActivity = Pick<ToolStageEvent, 'tool' | 'label'>;

export const WAITING_REPLY = '正在回复…';

export function activityText(activity: ToolActivity | null | undefined): string {
  if (!activity) return WAITING_REPLY;
  switch (activity.tool) {
    case 'load_skill': return activity.label ? `正在读取「${activity.label}」方法…` : '正在读取方法…';
    case 'research': return '正在联网搜索…';
    case 'read_source': return '正在查阅资料库…';
    case 'coach_review': return '正在读取你的作品数据…';
    default: return '正在处理…';
  }
}
