/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state=vi.hoisted(()=>({executions:[] as unknown[],reply:null as unknown,sessionArg:'',resumeRefetch:undefined as undefined|(()=>Promise<unknown>),
 resumeCall:undefined as undefined|((token:{executionId:string;cursor:number;epoch:number})=>Promise<unknown>),resume:vi.fn(),
 invalidated:[] as string[]}));
const turn=vi.hoisted(()=>(executionId:string,stateName:string,input:string,body:string|null=null)=>({executionId,state:stateName,input,body,primaryBody:null,
 organizerComplete:null,skillExecution:false,needsTask:false,unavailableReason:null,contentAvailable:true}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams('session=00000000-0000-4000-8000-000000000001')}));
vi.mock('@/components/opc/workspace-frame',()=>({WorkspaceFrame:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/opc/work-composer',()=>({WorkComposer:()=>null}));
vi.mock('@/components/opc/content-editor',()=>({ContentEditor:()=>null}));
vi.mock('@/components/opc/query-notice',()=>({QueryNotice:()=>null}));
vi.mock('@/lib/use-payg-resume',()=>({usePaygResume:(refetch:()=>Promise<unknown>,_onResult:unknown,
  call:(token:{executionId:string;cursor:number;epoch:number})=>Promise<unknown>)=>{state.resumeRefetch=refetch;state.resumeCall=call;
 return {busy:false,admitted:()=>true,block:()=>undefined,turnNotices:()=>[],blockedNotices:()=>[]};}}));
vi.mock('./use-runtime-stream',()=>({useRuntimeStream:(sessionId:string)=>{state.sessionArg=sessionId;
 return {reply:state.reply,run:vi.fn(),resume:state.resume,freeze:vi.fn(),call:{isSuccess:false},streaming:Boolean(state.reply)};}}));
vi.mock('@/trpc/client',()=>{
 const namespace=(group:string)=>new Proxy({}, {get:(_,name)=>({
  useQuery:()=>({data:group==='runtime'&&name==='view'?{scope:{kind:'positioning_draft'},executions:state.executions}:undefined,error:null,refetch:async()=>undefined}),
  useMutation:()=>({isPending:false,mutateAsync:vi.fn()}),
 })});
 const utils={credits:{getBalance:{invalidate:async()=>{state.invalidated.push('credits.getBalance');}}}};
 return {trpc:{runtime:namespace('runtime'),opc:namespace('opc'),user:namespace('user'),useUtils:()=>utils}};
});
import RuntimePage from './page';
const live=(executionId:string,text:string)=>({executionId,text,phase:'mentor',card:null,rev:1,points:text.length,stalled:false});
beforeEach(()=>{state.resume.mockReset();state.executions=[];state.reply=null;state.sessionArg='';state.resumeRefetch=undefined;state.invalidated=[];});

it('streams the reply of the running turn word by word instead of a placeholder',()=>{
 state.executions=[turn('e1','running','你好')];state.reply=live('e1','你好，连通');
 const html=renderToStaticMarkup(<RuntimePage/>);
 expect(state.sessionArg).toBe('00000000-0000-4000-8000-000000000001');
 expect(html.indexOf('你好，连通')).toBeGreaterThan(html.indexOf('>你好<'));
 expect(html).not.toContain('正在核实结果');
 expect(html).toContain('正在回复…');
});

it('shows the saved reply once the turn is finished, never the streamed copy',()=>{
 state.executions=[turn('e1','completed','你好','你好，连通正常。')];state.reply=live('e1','你好，连通');
 const html=renderToStaticMarkup(<RuntimePage/>);
 expect(html).toContain('你好，连通正常。');
 expect(html.match(/你好，连通/g)).toHaveLength(1);
});

it('does not show another turn\'s stream',()=>{
 state.executions=[turn('e1','running','你好')];state.reply=live('e2','别处的回复');
 expect(renderToStaticMarkup(<RuntimePage/>)).not.toContain('别处的回复');
});

it('re-reads the balance after a paused turn is continued (继续), like every streamed turn',async()=>{
 renderToStaticMarkup(<RuntimePage/>);
 expect(state.resumeRefetch).toBeTypeOf('function');
 await state.resumeRefetch!();
 expect(state.invalidated).toEqual(['credits.getBalance']);
});

it('continues (继续) a paused turn over the streamed resume with its own token',async()=>{
 renderToStaticMarkup(<RuntimePage/>);
 const token={executionId:'e1',cursor:2,epoch:1};
 await state.resumeCall!(token);
 expect(state.resume).toHaveBeenCalledExactlyOnceWith(token);
});
