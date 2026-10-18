import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { J_HERO_PROMISE } from '@/lib/landing/landing-copy-j';
import { J_TAKEOVER_MOMENTS } from '@/lib/landing/landing-copy-j-takeover';
import { L_HERO_PROMISE, L_NOTE_ANSWERS } from '@/lib/landing/landing-copy-l';
import { L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { L_LATER } from '@/lib/landing/landing-copy-l-later';
import { L_SCENARIOS, L_STEPS } from '@/lib/landing/landing-copy-l-steps';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe('the Owner\'s edits of 2026-10-18 (edit mode), carried into sample L only', () => {
  it('keeps sample J\'s own wording where L now has its own', () => {
    expect(L_HERO_PROMISE).toBe('运营从此交给 AI 教练，你只管专心输出你擅长的内容。');
    expect(J_HERO_PROMISE).toBe('运营从此交给我们的 AI 教练，你只管专心输出你擅长的内容。');
    expect(L_STEPS.one.stages[3].note).toBe('三步都确认后，AI 教练将根据你的信息生成定制化的策略分析报告。');
    expect(J_TAKEOVER_MOMENTS[3].note).toContain('十三章加一句话结论');
  });

  it('keeps the Owner\'s line breaks in the words and shows them on the page', () => {
    expect(L_LATER.two.lede.split('\n')).toEqual(['定位定下来以后，每周在同一个对话里：', '先选题，再定标题和封面，然后找资料、按你的写作风格写稿、出分镜。']);
    expect(L_NOTE_ANSWERS.p5).toContain('排好。\n打开');
    expect(read('l.module.css')).toMatch(/white-space: pre-line/);
    expect(read('SampleL.tsx')).toContain('own.lines');
  });

  it('titles region 6 in two lines and drops the scrolling hint under it', () => {
    expect(L_TASKS_TITLE).toBe('同一个任务，通用 AI VS Graylum AI 教练');
    expect(read('ScenariosL.tsx')).toContain('{index ? <br /> : null}');
    expect(Object.keys(L_SCENARIOS)).not.toContain('hintNext');
    expect(read('ScenariosL.tsx')).not.toContain('styles.hint');
  });
});
