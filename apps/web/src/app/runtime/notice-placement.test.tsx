/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const turn=vi.hoisted(()=>(executionId:string,state:string,input:string)=>({executionId,state,input,body:null,primaryBody:null,organizerComplete:null,
 skillExecution:false,needsTask:false,unavailableReason:null,contentAvailable:true}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams('session=00000000-0000-4000-8000-000000000001')}));
vi.mock('@/components/opc/workspace-frame',()=>({WorkspaceFrame:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/opc/work-composer',()=>({WorkComposer:()=><div data-composer=""/>}));
vi.mock('@/components/opc/content-editor',()=>({ContentEditor:()=>null}));
vi.mock('@/components/opc/query-notice',()=>({QueryNotice:()=>null}));
vi.mock('@/trpc/client',()=>{
 const view={scope:{kind:'positioning_draft'},executions:[turn('e1','completed','第一条'),turn('e2','running','最后一条')]};
 const namespace=(group:string)=>new Proxy({}, {get:(_,name)=>({
  useQuery:()=>({data:group==='runtime'&&name==='view'?view:undefined,error:null,refetch:async()=>undefined}),
  useMutation:()=>({isPending:false,mutateAsync:vi.fn()}),
 })});
 return {trpc:{runtime:namespace('runtime'),opc:namespace('opc'),user:namespace('user'),useUtils:()=>({})}};
});
import RuntimePage from './page';

it('puts the open turn notice and its actions under the last message, above the composer',()=>{
 const html=renderToStaticMarkup(<RuntimePage/>);
 const last=html.indexOf('最后一条'),notice=html.indexOf('回复尚未完成，原请求已保留。'),composer=html.indexOf('data-composer');
 expect(last).toBeGreaterThan(html.indexOf('第一条'));
 expect(notice).toBeGreaterThan(last);
 expect(composer).toBeGreaterThan(notice);
 expect(html.slice(notice)).toMatch(/<button type="button">重试<\/button><button type="button">停止<\/button>/);
 // One notice per open turn; the finished first turn has none.
 expect(html.match(/回复尚未完成/g)).toHaveLength(1);
 for(const old of ['恢复原任务','取消剩余执行','恢复引导请求'])expect(html).not.toContain(old);
});
