/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportPostsView, type ImportPostsViewProps } from './import-posts-view';

const noop = () => undefined;
const source = (extra: Partial<NonNullable<ImportPostsViewProps['sources']>[number]> = {}) => ({ connectionId: 'c1', platform: 'douyin',
  displayHint: '老周', supported: true, fetchedAt: '2026-11-14', posts: 2, autoTrack: true, ...extra });
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
  it('no connection: points to 数据复盘; no posts yet: says when they come, never a manual refresh that does not exist', () => {
    expect(render({ sources: [] })).toContain('去数据复盘连接');
    const daily = render({ sources: [source({ posts: 0 })] });
    expect(daily).toContain('每天会自动读一次');
    const off = render({ sources: [source({ posts: 0, autoTrack: false })] });
    expect(off).toContain('断开后重新连接并勾选');
    for (const html of [daily, off]) expect(html).not.toContain('刷新');
    expect(render({ sources: [source({ supported: false })] })).toContain('这个账号暂不支持导入');
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
