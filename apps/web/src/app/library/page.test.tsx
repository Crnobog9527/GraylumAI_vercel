/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ReactNode} from 'react';
const state=vi.hoisted(()=>({library:{} as Record<string,unknown>}));
vi.mock('@/trpc/client',()=>({trpc:{opc:{library:{useQuery:()=>state.library},editLibrary:{useMutation:()=>({})},saveContentManual:{useMutation:()=>({})},publicationUiChange:{useMutation:()=>({})}}}}));
vi.mock('@/components/opc/workspace-frame',()=>({WorkspaceFrame:({children}:{children:ReactNode})=>children}));
vi.mock('@/components/opc/content-editor',()=>({ContentEditor:()=>null}));
vi.mock('@/components/opc/version-compare',()=>({VersionCompare:()=>null}));
vi.mock('@/components/opc/strategy-overview-dialog',()=>({StrategyOverviewDialog:()=>null}));
import LibraryPage from './page';
const populated={businesses:[{businessId:'business',accounts:[{projectId:'account',platform:'测试平台',account:'测试账号',stage:'starting',items:[{workItemId:'item',title:'合成保存选题',content:[]}]}]}]};
beforeEach(()=>{state.library={isSuccess:true,isPending:false,data:{businesses:[]},error:null,refetch:vi.fn()};});
function render(){const html=renderToStaticMarkup(<LibraryPage/>);return {html,text:html.replace(/<[^>]*>/g,'')};}
function expectUnknownCounts(html:string,text:string){
 expect(text).toContain('— 个选题 · — 个账号');expect(text).toContain('显示 —–— / — 条');
 for(const label of ['全部选题','全部','待创作','草稿','已定稿','已发布'])expect(html).toContain(label+' <span>—</span>');
 expect(text).not.toContain('0 个选题');expect(text).not.toContain('0 个账号');expect(text).not.toContain('显示 0–0 / 0 条');
 expect(text).not.toContain('这个范围还没有收录选题');expect(text).not.toContain('尚无可用定位策略');
 expect(html).toContain('disabled="">上一页');expect(html).toContain('disabled="">下一页');
}
it('shows unknown counts while loading, without claiming an empty library',()=>{
 state.library={...state.library,isSuccess:false,isPending:true,data:undefined};
 const {html,text}=render();expectUnknownCounts(html,text);expect(text).toContain('正在读取资料库');
});
it.each(['FORBIDDEN','PRECONDITION_FAILED','INTERNAL_SERVER_ERROR'])('keeps %s separate from true zero counts',code=>{
 state.library={...state.library,isSuccess:false,data:undefined,error:{data:{code},message:'当前资料暂不可用。'}};
 const {html,text}=render();expectUnknownCounts(html,text);expect(html).toContain('role="alert"');expect(text).toContain('重试');
});
it('preserves cached items on refresh failure without presenting their counts as current',()=>{
 state.library={...state.library,isSuccess:false,data:populated,error:{data:{code:'FORBIDDEN'},message:'当前资料暂不可用。'}};
 const {html,text}=render();expectUnknownCounts(html,text);expect(text).toContain('测试账号');expect(text).toContain('合成保存选题');
 expect(html).toContain('测试账号<span>—</span>');expect(html).toContain('测试平台<span>—</span>');
});
it('shows real zero counts and the empty explanation only after a successful read',()=>{
 const {html,text}=render();expect(text).toContain('0 个选题 · 0 个账号');expect(text).toContain('显示 0–0 / 0 条');
 for(const label of ['全部选题','全部','待创作','草稿','已定稿','已发布'])expect(html).toContain(label+' <span>0</span>');
 expect(text).toContain('这个范围还没有收录选题');expect(html).not.toContain('role="alert"');expect(text).not.toContain('— 个账号');
});
it('retains successful populated counts and existing item rendering',()=>{
 state.library={...state.library,data:populated};const {html,text}=render();
 expect(text).toContain('1 个选题 · 1 个账号');expect(text).toContain('显示 1–1 / 1 条');
 expect(html).toContain('待创作 <span>1</span>');expect(text).toContain('合成保存选题');expect(text).toContain('测试账号');
});
