'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { WorkspaceSkeleton } from '@/components/opc/workspace-skeleton';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { classifyErasureError } from '@/lib/content-erasure';
import { trpc } from '@/trpc/client';
import { LEGACY_CONVERSATION_NOTICE, runtimePathChoice } from './runtime-path';
import { TurnWorkspace } from './turn-workspace';
import { WorkItemWorkspace } from './work-item-workspace';

export default function RuntimePage(){return <Suspense fallback={<WorkspaceSkeleton area="chat" label="内容读取中"/>}><RuntimeRoute/></Suspense>}
function RuntimeRoute(){
 const params=useSearchParams();
 const routeSession=params.get('session')??'';
 return routeSession?<RuntimePath key={routeSession} routeSession={routeSession}/>:<NewTask/>;
}
/** A new conversation starts on the start page (it keeps the first message and opens the conversation); an old link lands there. */
function NewTask(){
 const router=useRouter();
 useEffect(()=>{router.replace('/app/positioning');},[router]);
 return <WorkspaceSkeleton area="chat" label="正在进入新任务"/>;
}
/** `runtime.view` flags a conversation without turns as `legacy`; read defensively until every deployed server sends it. */
const legacyOf=(data:unknown)=>Boolean(data&&typeof data==='object'&&(data as {legacy?:unknown}).legacy===true);
/** A conversation the old execution path produced is not shown any more: say so and offer a new one, never a blank page. */
function LegacyConversation(){
 const router=useRouter();
 return <main className="p-6"><p role="status">{LEGACY_CONVERSATION_NOTICE}</p>
  <Button variant="outline" onClick={()=>router.push('/app/positioning')}>开始新对话</Button></main>;
}
/** CORE-PATH-V2: every free conversation and work item runs on the turn path; the conversation's scope decides the workspace. */
function RuntimePath({routeSession}:{routeSession:string}){
 const router=useRouter();
 const view=trpc.runtime.view.useQuery({sessionId:routeSession});
 // A deleted conversation (here, in another tab, or just before a reload) never stays open: start a new one.
 // NOT_FOUND (someone else's or a missing one, which read the same) leaves the same way.
 const erased=Boolean(view.error)&&(classifyErasureError(view.error,'preview').type==='gone'||view.error?.data?.code==='NOT_FOUND');
 useEffect(()=>{if(erased)router.replace('/app/positioning');},[erased,router]);
 const path=runtimePathChoice({viewSettled:Boolean(view.data)||Boolean(view.error),viewFailed:Boolean(view.error)&&!view.data,
  scopeKind:view.data?.scope?.kind,legacy:legacyOf(view.data)});
 // The sidebar frame is up at once; only the conversation area waits, as grey bars.
 if(path==='loading')return <WorkspaceFrame area="chat"><PageSkeleton composer/></WorkspaceFrame>;
 if(path==='turn')return <TurnWorkspace sessionId={routeSession}/>;
 if(path==='legacy')return <LegacyConversation/>;
 const scope=view.data?.scope;
 if(path==='work'&&scope?.kind==='work_item')return <WorkItemWorkspace sessionId={routeSession} workItemId={scope.workItemId}/>;
 return <main className="p-6"><p role="alert">暂时无法读取这项工作。</p><Button variant="outline" onClick={()=>void view.refetch()}>重新读取</Button></main>;
}
