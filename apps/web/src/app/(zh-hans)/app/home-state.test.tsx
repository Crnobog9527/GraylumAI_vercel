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
 expect(html.match(/<li>/g)).toHaveLength(6);
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
// Review of #1894: the two used to share one rule; changing the four boxes must not touch the six method steps (Owner 2026-11-12).
it('the six method steps keep their cards; only the four items at the foot of the page lose the box',()=>{
 const css=readFileSync(fileURLToPath(new URL('./home.module.css',import.meta.url)),'utf8');
 expect(css).toContain('.method li{border:1px solid #eee;border-radius:10px;padding:18px}');
 expect(css).toContain('.capabilities article{border-top:1px solid #eee;padding:14px 0 0}');
 expect(css).not.toMatch(/\.method li,[^{]*\.capabilities article/);
});
