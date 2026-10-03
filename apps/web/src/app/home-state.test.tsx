/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ library: {} as Record<string, unknown>, profile: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({trpc:{user:{getUserProfile:{useQuery:()=>state.profile}},opc:{library:{useQuery:()=>state.library}}}}));
vi.mock('@/hooks/use-credits',()=>({useCreditsBalance:()=>({status:'ready',credits:100})}));
import HomePage from './page';
import { HOME_STEPS } from './home-steps';
beforeEach(()=>{
 state.profile={data:{nickname:'Fixture',membership_level:'free'},isError:false};
 state.library={isSuccess:true,isPending:false,data:{businesses:[]},error:null,refetch:vi.fn()};
});
it('shows loading without claiming an empty directory or a new user',()=>{
 state.library={...state.library,isSuccess:false,isPending:true,data:undefined};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('正在读取账号与资料');
 expect(html).not.toContain('暂无已发布');expect(html).not.toContain('开始新手引导');
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
});
it('does not claim a membership level or placeholder name when the profile read fails',()=>{
 state.profile={data:undefined,isError:true};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('账户信息读取失败');expect(html).not.toContain('普通会员');expect(html).not.toContain('会员账户');expect(html).not.toContain('欢迎回来，用户');
});
it('shows the real name and membership when the profile is read',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('欢迎回来，Fixture');expect(html).toContain('普通会员');
});
