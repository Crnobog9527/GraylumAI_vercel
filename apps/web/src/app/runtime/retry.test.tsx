/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({session:'',kind:'',calls:[] as string[],retry:undefined as undefined|(()=>Promise<unknown>)}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams(state.session?'session='+state.session:'module=fixture')}));
vi.mock('@/components/opc/workspace-frame',()=>({WorkspaceFrame:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/opc/work-composer',()=>({WorkComposer:()=>null}));
vi.mock('@/components/opc/content-editor',()=>({ContentEditor:()=>null}));
vi.mock('@/components/opc/query-notice',()=>({QueryNotice:({retry}:{retry:()=>Promise<unknown>})=>{state.retry=retry;return null;}}));
vi.mock('@/trpc/client',()=>{
 const namespace=(group:string)=>new Proxy({}, {get:(_,name)=>({
  useQuery:()=>({data:group==='runtime'&&name==='view'&&state.session?{scope:{kind:state.kind},executions:[]}:undefined,error:group==='runtime'&&name==='choices'?{message:'temporary outage'}:null,refetch:async()=>{state.calls.push(group+'.'+String(name));}}),
  useMutation:()=>({isPending:false,mutateAsync:vi.fn()}),
 })});
 return {trpc:{runtime:namespace('runtime'),opc:namespace('opc'),user:namespace('user'),useUtils:()=>({})}};
});
import RuntimePage from './page';
beforeEach(()=>{state.session='';state.kind='';state.calls=[];state.retry=undefined;});
it.each([
 ['', '', ['runtime.choices']],
 ['00000000-0000-4000-8000-000000000001', 'positioning_draft', ['runtime.choices','runtime.view']],
 ['00000000-0000-4000-8000-000000000001', 'work_item', ['runtime.choices','runtime.view','opc.library']],
])('retries only queries whose session and scope are ready (%s, %s)',async(session,kind,expected)=>{
 state.session=session as string;state.kind=kind as string;
 renderToStaticMarkup(<RuntimePage/>);
 expect(state.retry).toBeTypeOf('function');await state.retry!();expect(state.calls).toEqual(expected);
});
