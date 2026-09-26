/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ catalog: {} as Record<string, unknown>, library: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({trpc:{user:{getUserProfile:{useQuery:()=>({data:{nickname:'Fixture',membership_level:'free'}})}},opc:{catalog:{useQuery:()=>state.catalog},library:{useQuery:()=>state.library}}}}));
vi.mock('@/hooks/use-credits',()=>({useCreditsBalance:()=>({status:'ready',credits:100})}));
import HomePage from './page';
beforeEach(()=>{
 state.catalog={isSuccess:true,isPending:false,data:[],error:null,refetch:vi.fn()};
 state.library={isSuccess:true,isPending:false,data:{businesses:[]},error:null,refetch:vi.fn()};
});
it('shows loading without claiming an empty directory or a new user',()=>{
 state.catalog={...state.catalog,isSuccess:false,isPending:true,data:undefined};
 state.library={...state.library,isSuccess:false,isPending:true,data:undefined};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('正在读取定位方法');expect(html).toContain('正在读取账号与资料');
 expect(html).not.toContain('暂无已发布');expect(html).not.toContain('开始新手引导');
});
it('labels a successfully read empty directory, separately from a failure',()=>{
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('暂无已发布定位方法');expect(html).toContain('开始新手引导');expect(html).not.toContain('role="alert"');
});
it.each(['PRECONDITION_FAILED','FORBIDDEN','SERVICE_UNAVAILABLE','INTERNAL_SERVER_ERROR'])('does not fabricate empty data on %s',code=>{
 state.catalog={...state.catalog,isSuccess:false,data:undefined,error:{data:{code},message:'当前测试窗口尚未开放或已关闭。'}};
 state.library={...state.library,isSuccess:false,data:undefined,error:{data:{code},message:'当前测试窗口尚未开放或已关闭。'}};
 const html=renderToStaticMarkup(<HomePage/>);
 expect(html).toContain('role="alert"');expect(html).toContain('重试');expect(html).toContain('进入对话');
 expect(html).not.toContain('定位方法准备中');expect(html).not.toContain('暂无已发布');expect(html).not.toContain('开始新手引导');expect(html).not.toContain('先一起确认定位');
});
it('renders workflow steps only from a successful catalog response',()=>{
 state.catalog={...state.catalog,data:[{workflow:{steps:[{id:'one',title:'认识自己'},{id:'two',title:'找到受众'}]}}]};
 const html=renderToStaticMarkup(<HomePage/>);expect(html).toContain('二个环节');expect(html).toContain('认识自己');expect(html).toContain('找到受众');
});
