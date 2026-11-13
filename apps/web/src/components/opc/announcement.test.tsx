/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ANNOUNCEMENT, ANNOUNCEMENT_CLOSED_KEY, ANNOUNCEMENT_CLOSED_MARK, ANNOUNCEMENT_FIRST_PAINT_SCRIPT } from '@/lib/announcement';

vi.mock('next/link', () => ({ default: ({ href, children, prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) =>
  <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a> }));
const { AnnouncementBar } = await import('./rail-view');

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');
const css = read('workspace-frame.module.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Runs the head's script against a browser that has `stored` under the key (or whose storage throws), and says what it marked. */
function firstPaint(stored: string | null | Error) {
  const marks: string[] = [];
  const localStorage = { getItem: (key: string) => { if (stored instanceof Error) throw stored; return key === ANNOUNCEMENT_CLOSED_KEY ? stored : null; } };
  const document = { documentElement: { setAttribute: (name: string) => { marks.push(name); } } };
  new Function('localStorage', 'document', ANNOUNCEMENT_FIRST_PAINT_SCRIPT)(localStorage, document);
  return marks;
}

// Owner 2026-11-12: the bar under the top bar is redesigned in the landing page's look, carries a line and a button, and stays closed.
describe('the announcement under the signed-in pages\' top bar', () => {
  it('says what it always said until a promotion takes its place: no new promise is written into it', () => {
    expect(ANNOUNCEMENT).toEqual({ id: 'explore', text: '让好想法，继续向前。', cta: '探索创作功能', href: '/app/workbench/marketplace' });
  });

  it('shows the line, the button that leads where it says (with the way back), and a way to close it', () => {
    const html = renderToStaticMarkup(<AnnouncementBar returnParam="?returnTo=%2Fapp" notice="测试环境" />);
    expect(html).toMatch(/^<div class="[^"]*announcement[^"]*" data-announcement="explore"><span>测试环境<\/span>/);
    expect(html).toMatch(/<i class="[^"]*announcementMark[^"]*" aria-hidden="true"><svg/);
    expect(html).toContain('<strong>让好想法，继续向前。</strong>');
    expect(html).toMatch(/<a href="\/app\/workbench\/marketplace\?returnTo=%2Fapp" data-prefetch="false">探索创作功能<svg/);
    expect(html).toMatch(/<button type="button" aria-label="关闭公告">/);
    // A promotion is the same bar with other words: its line, its button and its link.
    const promo = renderToStaticMarkup(<AnnouncementBar message={{ id: 'p1', text: '一行促销', cta: '去看看', href: '/app/profile?tab=subscription' }} />);
    expect(promo).toContain('data-announcement="p1"');
    expect(promo).toContain('<strong>一行促销</strong>');
    expect(promo).toMatch(/<a href="\/app\/profile\?tab=subscription"[^>]*>去看看<svg/);
  });

  it('stays closed: the head\'s script marks <html> before the first paint when this browser closed this announcement, and only then', () => {
    expect(firstPaint(ANNOUNCEMENT.id)).toEqual([ANNOUNCEMENT_CLOSED_MARK]);
    // Nothing closed, an older announcement closed, or a browser that keeps nothing: the bar shows.
    expect(firstPaint(null)).toEqual([]);
    expect(firstPaint('an-older-one')).toEqual([]);
    expect(firstPaint(new Error('storage is off'))).toEqual([]);
    const root = read('../layout/RootDocument.tsx');
    expect(root).toContain('<script dangerouslySetInnerHTML={{ __html: ANNOUNCEMENT_FIRST_PAINT_SCRIPT }} />');
    // The shell asks the same store, so the bar closed on one page is closed on the next.
    const frame = read('workspace-frame.tsx');
    expect(frame).toContain('const [noticeOpen,closeNotice]=useAnnouncementOpen();');
    expect(frame).toContain('onClose={closeNotice}');
    const hook = read('use-announcement.ts');
    expect(hook).toContain('window.localStorage.setItem(ANNOUNCEMENT_CLOSED_KEY, ANNOUNCEMENT.id)');
    expect(hook).toContain("document.documentElement.setAttribute(ANNOUNCEMENT_CLOSED_MARK, '')");
  });

  it('a closed bar leaves no gap and moves nothing: marked closed, it is not shown and the shell has the height it has without it', () => {
    expect(css).toContain(':global(html[data-announcement-closed]) .announcement{display:none}');
    const without = (rule: string) => (css.match(new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{height:([^}]*)\\}')) ?? [])[1];
    // Each height the shell has with the bar closed by its own button (.noNotice) is the height the mark gives it.
    expect(without(':global(html[data-announcement-closed]) .shell')).toBe(without('.shell.noNotice'));
    const phone = [...css.matchAll(/@media\(max-width:639px\)\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(block => block[1]).join('\n');
    expect(phone).toContain(':global(html[data-announcement-closed]) .shell,:global(html[data-announcement-closed]) .shell.withRight{height:calc(100dvh - 56px - var(--consent-bar-space, 0px))}');
    expect(phone).toContain(' .shell.noNotice{height:calc(100dvh - 56px - var(--consent-bar-space, 0px))}');
    expect(phone).toMatch(/:global\(html\[data-announcement-closed\]\) \.workspace\[data-tabs\] \.shell,[^{]*\{height:calc\(100dvh - 56px - 56px - env\(safe-area-inset-bottom, 0px\) - var\(--consent-bar-space, 0px\)\)\}/);
  });

  it('keeps its 40px, moves only where motion is welcome, and on a phone the line gives way before the button', () => {
    expect(css).toMatch(/\.announcement\{[^}]*height:40px/);
    const motion = [...css.matchAll(/@media\(prefers-reduced-motion:no-preference\)\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map(block => block[1]).join('\n');
    expect(motion).toContain('.announcement::before{animation:announcementDrift');
    expect(motion).toContain('.announcementMark svg{animation:announcementTwinkle');
    const still = css.replace(/@media\(prefers-reduced-motion:no-preference\)\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    for (const rule of still.match(/\.announcement[^{]*\{[^}]*\}/g) ?? []) expect(rule, rule).not.toMatch(/animation|transition/);
    // Only transforms move.
    expect(css).toContain('@keyframes announcementDrift{to{translate:-50% 0}}');
    expect(css).toMatch(/\.announcement strong\{[^}]*min-width:0;overflow:hidden;[^}]*text-overflow:ellipsis;white-space:nowrap\}/);
    expect(css).toMatch(/\.announcement a\{[^}]*flex:none/);
    // The button is a target large enough to press, and the close button too.
    expect(css).toMatch(/\.announcement>button\{[^}]*width:28px;height:28px/);
  });
});
