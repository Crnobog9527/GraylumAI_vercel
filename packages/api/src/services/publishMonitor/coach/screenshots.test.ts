/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { COACH_CAPTURE_INSTRUCTIONS, DIAG_MARK, extractScreenshots, visibleLength } from './screenshots';

const post = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const block = (value: unknown) => `${DIAG_MARK}\n${JSON.stringify(value)}\n\`\`\``;
const reply = (value: unknown) => `你的数字：2 秒跳出 35%。\n\n${block(value)}`;

describe('the hidden coach_diag block (screenshot numbers)', () => {
  it('is cut from the saved reply and its checked item goes to the close with the screenshot number and the label as read', () => {
    const r = extractScreenshots(reply({ items: [{ post_id: post, image: 2, rates: { bounce_2s: 0.35, avg_watch_seconds: 4.2, views: 1200 },
      raw: { '2秒跳出率': '35%' } }] }));
    expect(r.body).toBe('你的数字：2 秒跳出 35%。');
    expect(r.items).toEqual([{ postId: post, rates: { bounce_2s: 0.35, avg_watch_seconds: 4.2, views: 1200 },
      raw: { '2秒跳出率': { value: '35%', image: 2 } } }]);
  });

  it('keeps only normalized keys with sane values: unknown keys, out-of-range fractions, fractional counts and non-numbers are dropped', () => {
    const r = extractScreenshots(reply({ items: [{ post_id: post, rates: { bounce_2s: 35, retain_3s: 0.6, mystery: 0.5, views: 10.5, likes: 20,
      complete_rate: '15%', avg_watch_seconds: -1 } }] }));
    expect(r.items[0]!.rates).toEqual({ retain_3s: 0.6, likes: 20 });
    expect(extractScreenshots(reply({ items: [{ post_id: post, rates: { bounce_2s: 35 } }] })).items).toEqual([]);
  });

  it('a bad item is dropped on its own; two items of one post merge with the later value winning; at most six posts', () => {
    const r = extractScreenshots(reply({ items: [{ post_id: 'not-an-id', rates: { retain_3s: 0.5 } }, { post_id: post, rates: { retain_3s: 0.5, bounce_2s: 0.4 } },
      { post_id: post, image: 2, rates: { bounce_2s: 0.3 }, raw: { a: 1 } }] }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ postId: post, rates: { retain_3s: 0.5, bounce_2s: 0.3 }, raw: { a: { value: 1, image: 2 } } });
    const many = Array.from({ length: 9 }, (_, i) => ({ post_id: `00000000-0000-4000-8000-00000000000${i}`, rates: { retain_3s: 0.5 } }));
    expect(extractScreenshots(reply({ items: many })).items).toHaveLength(6);
  });

  it('a reply without a block, with broken JSON or with a block that never closed saves nothing and shows no block text', () => {
    expect(extractScreenshots('只有文字')).toEqual({ body: '只有文字', items: [] });
    expect(extractScreenshots(`文字\n${DIAG_MARK}\n{oops\n\`\`\``)).toEqual({ body: '文字', items: [] });
    expect(extractScreenshots(`文字\n${DIAG_MARK}\n{"items":[{"post_id":"${post}","rates":{"retain_3`)).toEqual({ body: '文字', items: [] });
    expect(extractScreenshots(reply({ nothing: true })).items).toEqual([]);
    expect(extractScreenshots(reply({ items: [{ post_id: other, rates: {} }] })).items).toEqual([]);
  });

  it('over-long text is cut instead of losing the item; text after the closed block stays; more than 20 items are cut at 20', () => {
    const long = 'x'.repeat(100);
    const r = extractScreenshots(`${reply({ items: [{ post_id: post, rates: { retain_3s: 0.5 }, raw: { [long]: 1, ok: long, bad: { a: 1 } }, opening_text: long.repeat(30) }] })}\n另外，祝顺利。`);
    expect(r.items[0]!.raw).toEqual({ ok: { value: 'x'.repeat(40), image: 1 } });
    expect(r.items[0]!.openingText).toHaveLength(2000);
    expect(r.body).toBe('你的数字：2 秒跳出 35%。\n另外，祝顺利。');
    const many = Array.from({ length: 25 }, (_, i) => ({ post_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, rates: { retain_3s: 0.5 } }));
    expect(extractScreenshots(reply({ items: many })).items).toHaveLength(6);
  });

  it('the stream shows nothing from the block on, and holds back a tail that may still become the start of the block', () => {
    const text = `你好\n\n${DIAG_MARK}\n{"items":[]}`;
    for (let end = 1; end <= text.length; end++) {
      const so = text.slice(0, end);
      const shown = so.slice(0, visibleLength(so));
      expect(shown.includes('`') && shown.includes('coach')).toBe(false);
      expect('你好\n\n'.startsWith(shown.trimEnd()) || shown.startsWith('你好')).toBe(true);
    }
    expect(visibleLength('完整的话。')).toBe('完整的话。'.length);
    expect(visibleLength('代码 ``')).toBe('代码 '.length);
    expect(visibleLength('代码 ```py\nx')).toBe('代码 ```py\nx'.length);
    expect('xx' + DIAG_MARK).toHaveLength(visibleLength('xx' + DIAG_MARK) + DIAG_MARK.length);
  });

  it('the instructions give the model the same keys and limit the code checks', () => {
    for (const key of ['bounce_2s', 'retain_3s', 'avg_watch_seconds', 'views', 'followers_gained', DIAG_MARK, 'ask the user which']) expect(COACH_CAPTURE_INSTRUCTIONS).toContain(key);
  });
});
