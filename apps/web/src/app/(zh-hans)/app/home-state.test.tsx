/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ library: {} as Record<string, unknown>, profile: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({trpc:{user:{getUserProfile:{useQuery:()=>state.profile}},opc:{library:{useQuery:()=>state.library}}}}));
vi.mock('@/hooks/use-credits',()=>({useCreditsBalance:()=>({status:'ready',credits:100})}));
vi.mock('@/components/layout/LanguageSwitch',()=>({LanguageSwitch:()=><button data-language-switch=""/>}));
import HomePage from './page';
import { HOME_STEPS } from './home-steps';
import { HOME_VISUAL_WORDS } from './home-visuals';
beforeEach(()=>{
 state.profile={data:{nickname:'Fixture',membership_level:'free'},isError:false};
 state.library={isSuccess:true,isPending:false,data:{businesses:[]},error:null,refetch:vi.fn()};
});
it('shows loading without claiming an empty directory or a new user',()=>{
 state.library={...state.library,isSuccess:false,isPending:true,data:undefined};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('正在读取');
 expect(html).not.toContain('暂无已发布');expect(html).not.toContain('开始新手引导');
});
it('starts 我已有定位 in the Agent workspace, not the library (R15)',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toMatch(/<a href="\/app\/positioning">我已有定位<\/a>/);
 expect(html).not.toMatch(/<a href="\/app\/library">我已有定位/);
});
it('offers onboarding to a new user without any alert',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('开始新手引导');expect(html).toContain('我已有定位');expect(html).not.toContain('role="alert"');
});
it.each(['PRECONDITION_FAILED','FORBIDDEN','SERVICE_UNAVAILABLE','INTERNAL_SERVER_ERROR'])('does not fabricate empty data on %s',code=>{
 state.library={...state.library,isSuccess:false,data:undefined,error:{data:{code},message:'当前测试窗口尚未开放或已关闭。'}};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('role="alert"');expect(html).toContain('重试');expect(html).toContain('进入对话');
 expect(html).not.toContain('定位方法准备中');expect(html).not.toContain('暂无已发布');expect(html).not.toContain('开始新手引导');expect(html).not.toContain('先一起确认定位');
});
it('renders the six static steps with labelled parts and no catalog dependency',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(HOME_STEPS).toHaveLength(6);
 expect(html.match(/<li[ >]/g)).toHaveLength(6);
 HOME_STEPS.forEach((step,index)=>{
  expect(html).toContain(String(index+1).padStart(2,'0'));expect(html).toContain(step.title);
  expect(html).toContain(step.purpose);expect(html).toContain(step.outcome);expect(html).toContain(step.why);
 });
 expect(html.match(/<dt>目的<\/dt>/g)).toHaveLength(6);
 expect(html.match(/<dt>你会得到<\/dt>/g)).toHaveLength(6);
 expect(html.match(/<dt>为什么重要<\/dt>/g)).toHaveLength(6);
 expect(html).not.toContain('个环节，理解你的内容增长路径');expect(html).not.toContain('Agent 提供分析与建议');
 expect(html).not.toContain('具体问题将在进入定位工作后呈现');expect(html).not.toContain('定位方法');
 expect(html).toContain('aria-label="我们怎样帮你做定位"');expect(html).not.toContain('定位工作步骤');
});
it('does not claim a membership level or placeholder name when the profile read fails',()=>{
 state.profile={data:undefined,isError:true};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('账户信息读取失败');expect(html).not.toContain('免费版');expect(html).not.toContain('会员账户');expect(html).not.toContain('你好，用户');
});
it('shows the real name and membership when the profile is read',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('你好，Fixture');expect(html).not.toContain('欢迎回来');expect(html).toContain('免费版');
});
// Walkthrough 2026-11-11, items 8 and 14.
it('greets without claiming a return visit, and shows a phone account without a name by its last four digits',()=>{
 state.profile={data:{nickname:'user-0a1b2c3d',membership_level:'free',phone_masked:'138****5678'},isError:false};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('你好，手机尾号 5678');expect(html).not.toContain('user-0a1b2c3d');expect(html).not.toContain('欢迎回来');
});
// Owner 2026-11-12 redesigned this page (sample H1), which replaces "the six method steps keep their cards … unchanged before launch"
// (#1922): the two rules this test used to pin word for word are gone. What it protected still holds, below.
const read=(name:string)=>readFileSync(fileURLToPath(new URL(name,import.meta.url)),'utf8');
it('the four items at the foot of the page are named, not offered: no link, no box, nothing that answers a pointer',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 const foot=html.slice(html.indexOf('从策略，继续走向实际创作'),html.indexOf('</main>'));
 expect(foot.match(/<article/g)).toHaveLength(4);expect(foot).not.toMatch(/<a |<button/);
 const css=read('./home.module.css');
 const [,rule='']=css.match(/\.capabilities article \{([^}]*)\}/)??[];
 expect(rule).toContain('display: grid');expect(rule).not.toMatch(/border|box-shadow|background|cursor/);expect(css).not.toMatch(/\.capabilities[^{]*:hover/);
});
it('shows one of the six steps at a time, the first to begin with, and each stop of the route names the step it shows',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 const steps=[...html.matchAll(/<li id="([^"]+)"[^>]*>/g)];
 expect(steps).toHaveLength(6);
 expect(steps.map(step=>step[0].includes('data-on'))).toEqual([true,false,false,false,false,false]);
 const stops=[...html.matchAll(/<button type="button" aria-controls="([^"]+)"([^>]*)>/g)];
 expect(stops.map(stop=>stop[1])).toEqual(steps.map(step=>step[1]));
 expect(stops.map(stop=>stop[2].includes('aria-current="step"'))).toEqual([true,false,false,false,false,false]);
 expect(html).toContain('上一步');expect(html).toContain('下一步');
});
it("a step's picture says only what the step's own text says, and is kept from a screen reader",()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(HOME_VISUAL_WORDS).toHaveLength(HOME_STEPS.length);
 HOME_VISUAL_WORDS.forEach((words,index)=>{
  const step=HOME_STEPS[index];const said=step.purpose+step.outcome;
  for(const word of words){expect(said,`${step.title}: ${word}`).toContain(word);expect(html).toContain(`>${word}<`);}
 });
 expect(html.match(/aria-hidden="true"><div class="[^"]*viz/g)).toHaveLength(6);
});
it('moves only where motion is welcome, and the light behind the page is the whole page\'s, not the column\'s',()=>{
 for(const name of ['./home.module.css','./home-method.module.css']){
  const css=read(name).replace(/\/\*[\s\S]*?\*\//g,'');
  // Outside the "motion is welcome" blocks nothing animates or transitions; keyframes alone do nothing.
  const still=css.replace(/@media[^{]*prefers-reduced-motion: no-preference[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,'').replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,'');
  expect(still,name).not.toMatch(/animation|transition/);
 }
 const html=renderToStaticMarkup(<HomePage/>);
 // The light is the page root's first child, before the top bar and outside <main>, so the 1160px column cannot cut it.
 expect(html).toMatch(/<div class="[^"]*home[^"]*"><div class="[^"]*glow[^"]*" aria-hidden="true">/);
 expect(html.slice(html.indexOf('<main'))).not.toContain('glow');
 expect(read('./home.module.css')).toMatch(/\.glow \{[^}]*inset: 0 0 auto;[^}]*overflow: hidden/);
});
it('choosing a step moves nothing below it: the six steps share one place and the ones not shown keep their room',()=>{
 const css=read('./home-method.module.css');
 expect(css).toMatch(/\.panels \{[^}]*display: grid/);expect(css).toMatch(/\.panel \{[^}]*grid-area: 1 \/ 1/);
 expect(css).toContain('.panel:not([data-on]) { visibility: hidden; }');expect(css).not.toMatch(/\.panel[^{]*\{[^}]*display: none/);
});
it('carries the phone\'s bottom bar, on 首页, after the page itself',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 const bar=html.slice(html.indexOf('</main>'));
 expect(bar).toMatch(/<nav [^>]*aria-label="主导航"/);
 expect(bar).toMatch(/aria-current="page"[^>]*href="\/app"|href="\/app"[^>]*aria-current="page"/);expect(bar.match(/aria-current="page"/g)).toHaveLength(1);
});
// Owner 2026-11-12, phone plan A: "这 6 个步骤不要做左右滑动，直接从上到下排列好……带步骤动效、有箭头引导的展示".
it('on a phone the six steps stand one under another with an arrow between them, and all six show before the page has looked',()=>{
 const css=read('./home-method.module.css').replace(/\/\*[\s\S]*?\*\//g,'');
 const [,phone='']=css.match(/@media \(max-width: 639px\) \{((?:[^{}]|\{[^{}]*\})*)\}/)??[];
 // No row of stops and no 上一步 / 下一步; every step is laid out in its own place and shown; the arrow sits above each step but the first.
 expect(phone).toContain('.route, .turn { display: none; }');
 expect(phone).toMatch(/\.panel \{ grid-area: auto;/);expect(phone).toContain('.panel:not([data-on]) { visibility: visible; }');
 expect(phone).toMatch(/\.panel \+ \.panel::before \{/);expect(phone).toMatch(/\.panel \+ \.panel::after \{/);
 // A step waits out of sight only once the page is watching (data-watch) and only where motion is welcome; nothing else hides a step.
 const waits=[...css.matchAll(/@media ([^{]*)\{((?:[^{}]|\{[^{}]*\})*)\}/g)].filter(block=>block[2].includes(':not([data-seen])'));
 expect(waits).toHaveLength(1);
 expect(waits[0][1]).toContain('(max-width: 639px)');expect(waits[0][1]).toContain('prefers-reduced-motion: no-preference');
 expect(waits[0][2]).toContain('.panels[data-watch] .panel:not([data-seen]) { opacity: 0;');
 expect(css.replace(waits[0][0],'')).not.toContain('data-seen');
 // As the server draws it (and wherever the script does not run): no watching, nothing marked seen, the first step's picture playing.
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).not.toContain('data-watch');expect(html).not.toContain('data-seen');
 expect([...html.matchAll(/<li id="[^"]+"[^>]*>/g)].map(step=>step[0].includes('data-play'))).toEqual([true,false,false,false,false,false]);
 // The pictures play by that one mark, on a computer and on a phone alike.
 expect(css).toContain('.panel[data-play] .viz { animation: loop');expect(css).not.toMatch(/\.panel\[data-on\][^{]*\{[^}]*animation/);
});
// Controller 2026-11-12, from the phone sample the Owner chose (its first screen: the two buttons in the title's card).
it('on a phone the two buttons sit under the title, before the six steps; the document keeps its order',()=>{
 const css=read('./home.module.css').replace(/\/\*[\s\S]*?\*\//g,'');
 const [,phone='']=css.match(/@media \(max-width: 639px\) \{((?:[^{}]|\{[^{}]*\})*)\}/)??[];
 expect(phone).toContain('.page { display: flex; flex-direction: column; }');
 // The steps (the one section with a label) and the four items at the foot are moved after everything else, in that order.
 expect(phone).toContain('.page > section[aria-label] { order: 1;');expect(phone).toContain('.capabilities { order: 2; }');
 expect(css.replace(phone,'')).not.toMatch(/[\s;{]order:/);
 const html=renderToStaticMarkup(<HomePage/>);
 const main=html.slice(html.indexOf('<main'));
 expect(main.match(/<section[^>]* aria-label="/g)).toHaveLength(1);
 // In the document: greeting, title, the six steps, the buttons, the four items.
 const at=(text:string)=>main.indexOf(text);
 expect([at('你好，Fixture'),at('拥有清楚的内容方向'),at('我们怎样帮你做定位'),at('开始新手引导'),at('从策略，继续走向实际创作')].every((place,index,all)=>place>0&&(index===0||place>all[index-1]))).toBe(true);
});
