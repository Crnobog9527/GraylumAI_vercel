import { describe, expect, it } from 'vitest';
import { activityText, WAITING_REPLY } from './tool-activity';

describe('the line a waiting reply shows', () => {
  it('says what each kind of tool is doing, and names a Skill by its public name', () => {
    expect(activityText({ tool: 'load_skill', label: '分镜' })).toBe('正在读取「分镜」方法…');
    expect(activityText({ tool: 'load_skill' })).toBe('正在读取方法…');
    expect(activityText({ tool: 'research' })).toBe('正在联网搜索…');
    expect(activityText({ tool: 'read_source' })).toBe('正在查阅资料库…');
    expect(activityText({ tool: 'coach_review' })).toBe('正在读取你的作品数据…');
    expect(activityText({ tool: 'other' })).toBe('正在处理…');
  });
  it('without a tool it is the plain waiting line', () => {
    expect(activityText(undefined)).toBe(WAITING_REPLY);
    expect(activityText(null)).toBe('正在回复…');
  });
});
