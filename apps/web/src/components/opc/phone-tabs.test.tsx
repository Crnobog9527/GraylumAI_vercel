/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhoneTabs } from './phone-tabs';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const block = (css: string, query: string) => [...css.matchAll(/@media\s*([^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  .filter(match => match[1].replace(/\s/g, '') === query.replace(/\s/g, '')).map(match => match[2]).join('\n');

// Owner 2026-11-12, phone plan A: the signed-in product on a phone has a bottom bar, "首页 · 对话 · 功能 · 我的".
describe('a phone\'s bottom bar', () => {
  it('has the four places, in the Owner\'s order, each a link, and marks the one the page is', () => {
    const html = renderToStaticMarkup(<PhoneTabs on="tools" />);
    expect([...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(?:<svg.*?<\/svg>)([^<]+)<\/a>/g)].map(link => [link[2], link[1]])).toEqual([
      ['首页', '/app'], ['对话', '/app/chats'], ['功能', '/app/tools'], ['我的', '/app/profile'],
    ]);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/app\/tools"|href="\/app\/tools"[^>]*aria-current="page"/);
    expect(html).toMatch(/^<nav [^>]*aria-label="主导航"/);
    expect(renderToStaticMarkup(<PhoneTabs />)).not.toContain('aria-current');
  });

  it('is a phone\'s alone: hidden everywhere, shown under 640px, clear of the home indicator and of the consent bar', () => {
    const css = bare(read('phone-tabs.module.css'));
    const phone = block(css, '(max-width: 639px)');
    expect(css.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').trim()).toBe('.tabs { display: none; }');
    expect(phone).toMatch(/\.tabs \{[^}]*position: fixed;[^}]*display: grid/);
    expect(phone).toMatch(/\.tabs \{[^}]*inset: auto 0 var\(--consent-bar-space, 0px\) 0/);
    expect(phone).toMatch(/\.tabs \{[^}]*env\(safe-area-inset-bottom/);
    // Every place is a target a thumb can hit.
    expect(phone).toMatch(/\.tabs a \{[^}]*min-height: 44px/);
    expect(css).not.toMatch(/animation|transition/);
  });

  it('is left out of the conversation and topics pages, where the message box sits at the foot, and shown by every other page of the shell', () => {
    const frame = read('workspace-frame.tsx');
    expect(frame).toContain("const phoneTab:PhoneTab|null=area==='chat'||area==='topics'?null:area==='start'||area==='history'?'chats':'tools';");
    expect(frame).toContain("data-tabs={phoneTab?'':undefined}");
    expect(frame).toContain('{phoneTab&&<PhoneTabs on={phoneTab}/>}');
  });

  it('where it shows, the shell ends above it, the drawer\'s button and the top bar\'s three links go, and the 对话 page is the rail\'s own list', () => {
    const css = bare(read('workspace-frame.module.css'));
    const phone = block(css, '(max-width:639px)');
    expect(phone).toContain('.workspace[data-tabs] .mobileGlobalMenu,.workspace[data-tabs] .global nav{display:none}');
    expect(phone).toMatch(/\.workspace\[data-tabs\] \.shell,\.workspace\[data-tabs\] \.shell\.withRight\{height:calc\(100dvh - 96px - 56px - env\(safe-area-inset-bottom, 0px\) - var\(--consent-bar-space, 0px\)\)\}/);
    expect(phone).toMatch(/\.workspace\[data-area=history\] \.rail\{display:flex;position:static/);
    // The list page keeps the drawer's own scrolling (overflow-y:auto) and its list's 120px floor: a short screen never squeezes the list away.
    expect(phone).not.toMatch(/\.workspace\[data-area=history\] \.rail\{[^}]*overflow/);
    expect(phone).toMatch(/ \.rail\{display:none;position:fixed;[^}]*overflow-y:auto;overscroll-behavior:contain\}/);
    expect(phone).toContain(' .rail .history{min-height:120px}');
    expect(phone).toMatch(/\.workspace\[data-area=history\] \.center,[^{]*\.railNav,[^{]*\.railBottom\{display:none\}/);
    // The 对话 page's name shows on that page only, and only on a phone.
    expect(css).toContain('.phoneTitle{display:none}');
    expect(phone).toMatch(/\.workspace\[data-area=history\] \.phoneTitle\{display:block/);
    expect(read('rail-view.tsx')).toContain("{area==='history'&&<h1 className={styles.phoneTitle}>对话</h1>}");
  });

  // Controller 2026-11-12: one phone breakpoint for the shell, under 640px (it was 700px).
  it('the shell and the home page turn into their phone layout at one width, under 640px', () => {
    const css = bare(read('workspace-frame.module.css'));
    expect(css).not.toMatch(/700px|701px/);
    expect(css).toMatch(/@media\(min-width:640px\) and \(max-height:780px\)/);
    expect(read('workspace-frame.tsx')).toContain("window.matchMedia('(max-width:639px)')");
    const home = bare(readFileSync(join(__dirname, '../../app/(zh-hans)/app/home.module.css'), 'utf8'));
    expect(home).not.toMatch(/700px/);
    expect(home).toMatch(/@media\(max-width:639px\)\{[^@]*\.home header nav\{display:none\}/);
  });
});
