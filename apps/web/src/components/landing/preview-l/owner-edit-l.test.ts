import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { editList, foldEdits } from '@/components/landing/preview-j/OwnerEditJ';
import { L_DIRECTION_CARD } from '@/lib/landing/landing-copy-l-positioning';
import { L_NOTE_ANSWERS } from '@/lib/landing/landing-copy-l';
import { demoCopyGroupsL } from './demo-copy-l';
import { OwnerEditL } from './OwnerEditL';

const web = join(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(web, path), 'utf8');

describe('sample L\'s edit mode (Owner 2026-10-18): the preview page only, a local development server only', () => {
  it('is mounted by the preview page alone, behind the development check; never by SampleL or /landing', () => {
    const preview = read('src/app/landing/preview/l/page.tsx');
    expect(preview).toMatch(/process\.env\.NODE_ENV === 'development'\s*\?\s*dynamic\(\(\) => import\('@\/components\/landing\/preview-l\/OwnerEditL'\)/);
    // The live landing page, and everything sample L is built from (which #1088 turns into it), carry none of it: only a
    // passive check of the editing mark (use-owner-editing), which nothing outside a development server ever sets.
    expect(read('src/app/landing/page.tsx')).not.toMatch(/OwnerEdit|owner-edits|改字/);
    const parts = readdirSync(join(web, 'src/components/landing/preview-l'))
      .filter(name => /\.tsx?$/.test(name) && !name.includes('.test.') && !['OwnerEditL.tsx', 'demo-copy-l.ts'].includes(name));
    for (const name of parts) expect(read(`src/components/landing/preview-l/${name}`), name).not.toMatch(/OwnerEdit[JL]|owner-edits|demo-copy-l/);
  });

  it('starts switched off, with the export, and lists the text the demos play', () => {
    const html = renderToStaticMarkup(createElement(OwnerEditL));
    expect(html).toContain('改字模式：关');
    const groups = demoCopyGroupsL();
    const all = groups.flatMap(group => group.items.map(item => item.text));
    expect(groups.map(group => group.title)).toEqual(['首屏演示', '第一步 · 定位对话', '第二步、第三步 · 每周对话', '评审团动画', '区域 6 · 同一个问题两种回答']);
    expect(all).toContain(L_DIRECTION_CARD.options[0]);
    for (const group of groups) expect(group.items.length, group.title).toBeGreaterThan(0);
    // Region 2's answers are page text, edited in place, not here.
    expect(all).not.toContain(L_NOTE_ANSWERS.p7);
  });

  it('exports one 原文 → 新文 list, a change of a change folded into one', () => {
    const edits = foldEdits([
      { module: '用户心声', original: '甲', edited: '乙' },
      { module: '用户心声', original: '乙', edited: '丙' },
      { module: '价格', original: '一', edited: '二' },
      { module: '价格', original: '三', edited: '三' },
    ]);
    expect(edits).toEqual([{ module: '用户心声', original: '甲', edited: '丙' }, { module: '价格', original: '一', edited: '二' }]);
    const list = editList('/landing/preview/l', edits, new Date(2026, 9, 18, 9, 0));
    expect(list).toContain('共 2 处');
    expect(list).toContain('1. 【用户心声】\n原文：甲\n新文：丙');
    expect(list).toContain('2. 【价格】\n原文：一\n新文：二');
  });
});
