/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { importReadError, importReadNotice } from '@/lib/voice/import-read';
import { ImportPostsView, type ImportPostsViewProps } from './import-posts-view';

const noop = () => undefined;
const source = (extra: Partial<NonNullable<ImportPostsViewProps['sources']>[number]> = {}) => ({ connectionId: 'c1', platform: 'douyin',
  displayHint: '老周', supported: true, fetchedAt: '2026-11-14', posts: 2, ...extra });
const render = (props: Partial<ImportPostsViewProps> = {}) => renderToStaticMarkup(<ImportPostsView sources={[source()]} busy={false}
  open={null} candidates={null} picked={[]} onOpen={noop} onPick={noop} onImport={noop} {...props} />);

describe('从我的账号导入 (VOICE-2 PR-6)', () => {
  it('says what is imported and that importing costs nothing', () => {
    const html = render();
    expect(html).toContain('只导入帖子文案');
    expect(html).toContain('导入本身不扣积分');
    expect(html).toContain('抖音 · 老周');
    expect(html).toContain('选择帖子（2）');
  });
  it('no connection: points to 数据复盘; a TikHub account can be read now (billed by use, no estimate); Post for Me cannot', () => {
    expect(render({ sources: [] })).toContain('去数据复盘连接');
    const empty = render({ sources: [source({ posts: 0, fetchedAt: null })] });
    expect(empty).toContain('还没有读到帖子');
    expect(empty).toContain('读取最新帖子');
    expect(empty).toContain('按实际用量扣积分');
    expect(empty).toContain('每个账号每小时一次');
    expect(empty).not.toContain('选择帖子');
    expect(empty).not.toMatch(/\d+\s*积分/);
    expect(render()).toContain('最近一次读到 2 条（2026-11-14）');
    const unsupported = render({ sources: [source({ supported: false })] });
    expect(unsupported).toContain('这个账号暂不支持导入');
    expect(unsupported).not.toContain('读取最新帖子');
  });
  it('reading: the button says so and everything waits; the result or refusal shows under that account only', () => {
    const reading = render({ reading: 'c1', busy: true });
    expect(reading).toContain('正在读取…');
    expect(reading).toMatch(/<button type="button" disabled="">正在读取…/);
    const two = [source(), source({ connectionId: 'c2', displayHint: '小号' })];
    const low = render({ sources: two, notice: { connectionId: 'c2', ...importReadNotice('insufficient_credits') } });
    expect(low).toContain('积分不够');
    expect(low.indexOf('积分不够')).toBeGreaterThan(low.indexOf('小号'));
    expect(low).toContain('role="alert"');
    expect(render({ notice: { connectionId: 'c1', ...importReadError('rate_limited') } })).toContain('1 小时内只能读取 1 次');
    expect(render({ notice: { connectionId: 'c1', ...importReadNotice('read') } })).toContain('role="status"');
    expect(importReadNotice('not_fetched').text).toContain('没有扣积分');
    expect(importReadError(null).text).toContain('不会重复扣费');
  });
  it('an opened account lists its posts; an imported one is ticked and locked; the button counts the picks', () => {
    const html = render({ open: 'c1', picked: ['p2'], candidates: [
      { postId: 'p1', text: '各位街坊，晚上好', url: null, postedAt: '2026-11-01T10:00:00Z', imported: true },
      { postId: 'p2', text: '今天去菜市场', url: null, postedAt: null, imported: false }] });
    expect(html).toContain('已导入');
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/><span>各位街坊/);
    expect(html).toContain('导入所选（1）');
    expect(html).toContain('收起');
  });
});
