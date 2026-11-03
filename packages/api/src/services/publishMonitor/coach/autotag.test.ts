/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { pillarOfTitle, tagFromTitles } from './autotag';

const pillars = [{ key: 'p1', name: '读书笔记', definition: '读书笔记' }, { key: 'p2', name: '穿搭灵感', definition: '穿搭灵感' },
  { key: 'p3', name: '城市探店', definition: '城市探店' }];
const post = (postId: string, title: string | null, pillarKey: string | null = null) => ({ postId, title, pillarKey, pillarSource: null as string | null });

describe('pillars taken from titles by code', () => {
  it('names the pillar a title carries, in brackets, as a tag or inside the text; none or two is left to the model', () => {
    expect(pillarOfTitle('【读书笔记】 一张图看懂', pillars)).toBe('p1');
    expect(pillarOfTitle('#城市探店 新手最容易忽略的一步', pillars)).toBe('p3');
    expect(pillarOfTitle('今天的穿搭灵感：三件基础款', pillars)).toBe('p2');
    expect(pillarOfTitle('【 读书 笔记 】', pillars)).toBe('p1');
    expect(pillarOfTitle('读书笔记和城市探店合集', pillars)).toBeNull();
    expect(pillarOfTitle('周末随手拍', pillars)).toBeNull();
    expect(pillarOfTitle(null, pillars)).toBeNull();
    expect(pillarOfTitle('【读书笔记】', [])).toBeNull();
    // A one-character name would match almost anything.
    expect(pillarOfTitle('吃', [{ key: 'p1', name: '吃', definition: '吃' }])).toBeNull();
  });

  it('tags only posts without a pillar, never overwrites one, and lists the new tags', () => {
    const items = [post('a', '【读书笔记】 x'), post('b', '【读书笔记】 y', 'p2'), post('c', '没有栏目'), post('d', '城市探店 z')];
    const result = tagFromTitles(items, pillars);
    expect(result.items.map(item => item.pillarKey)).toEqual(['p1', 'p2', null, 'p3']);
    expect(result.items[0]).toMatchObject({ pillarSource: 'model' });
    expect(result.items[1]).toBe(items[1]);
    expect(result.tags).toEqual([{ post_id: 'a', pillar_key: 'p1' }, { post_id: 'd', pillar_key: 'p3' }]);
    expect(items[0]!.pillarKey).toBeNull();
  });
});
