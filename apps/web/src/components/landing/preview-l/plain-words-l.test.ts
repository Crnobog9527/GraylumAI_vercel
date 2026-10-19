import { describe, expect, it } from 'vitest';
import { J_TAKEOVER_MOMENTS } from '@/lib/landing/landing-copy-j-takeover';
import { L_LATER, L_LATER_FLYWHEEL } from '@/lib/landing/landing-copy-l-later';
import { L_PLAIN_SWAPS, L_POSITIONING_MOMENTS } from '@/lib/landing/landing-copy-l-positioning';
import { L_TASKS } from '@/lib/landing/landing-copy-l-compare';
import { L_WORKFLOWS } from '@/lib/landing/landing-copy-l-workflows';

const j = J_TAKEOVER_MOMENTS.flatMap(moment => moment.lines.map(line => line.text)).join('\n');
const l = L_POSITIONING_MOMENTS.flatMap(moment => moment.lines.map(line => line.text)).join('\n');
// The cover's own words ("剩菜 → 三道菜", what is printed on the cover) are not the coach talking.
const coach = JSON.stringify([L_WORKFLOWS, L_TASKS, L_LATER, L_LATER_FLYWHEEL]).replace('剩菜 → 三道菜', '');

describe('the coach in plain words (round thirteen, Owner 2026-10-18: "改成大白话")', () => {
  it('swaps every inside word in the lines sample L borrows, sample J keeping its own', () => {
    for (const [from, to] of L_PLAIN_SWAPS) {
      expect(j, from).toContain(from);
      expect(l, from).not.toContain(from);
      expect(l, to).toContain(to);
    }
  });

  it('never uses "率" on its own as a noun nor joins sentences with arrows, and explains its terms', () => {
    for (const word of ['这几个率', '先看率', '从率出发', '这些率', '上面的率', '→ ', '计入', '取到', '平均观看占时长', '中位数', '钩子']) {
      expect(coach, word).not.toContain(word);
    }
    for (const word of ['计入', '高概率推断', '同量级', '赛道很挤', '样本里', '测试期']) expect(l, word).not.toContain(word);
    const thisWeek = L_WORKFLOWS[1][0].reply;
    expect(thisWeek).toContain('**从这几个数据指标看出来的**');
    expect(thisWeek).toContain('关注率：看完点关注的人占比');
    expect(thisWeek).toContain('主页访问率：看完点进你主页的人占比');
    expect(thisWeek).toContain('所以以后每条开头都先给成品。');
  });
});
