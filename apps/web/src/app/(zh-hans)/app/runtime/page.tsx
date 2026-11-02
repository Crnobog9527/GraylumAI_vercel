'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { classifyErasureError } from '@/lib/content-erasure';
import { trpc } from '@/trpc/client';
import { runtimePathChoice } from './runtime-path';
import { TurnWorkspace } from './turn-workspace';
import { WorkItemWorkspace } from './work-item-workspace';

export default function RuntimePage(){return <Suspense fallback={<p>正在读取工作…</p>}><RuntimeRoute/></Suspense>}
function RuntimeRoute(){
 const params=useSearchParams();
 const routeSession=params.get('session')??'';
 return routeSession?<RuntimePath key={routeSession} routeSession={routeSession}/>:<NewTask/>;
}
/** A new conversation starts on the start page (it keeps the first message and opens the conversation); an old link lands there. */
function NewTask(){
 const router=useRouter();
 useEffect(()=>{router.replace('/app/positioning');},[router]);
 return <p>正在进入新任务…</p>;
}
/** CORE-PATH-V2: every free conversation and work item runs on the turn path; the conversation's scope decides the workspace. */
function RuntimePath({routeSession}:{routeSession:string}){
 const router=useRouter();
 const view=trpc.runtime.view.useQuery({sessionId:routeSession});
 // A deleted conversation (here, in another tab, or just before a reload) never stays open: start a new one.
 // NOT_FOUND (someone else's or a missing one, which read the same) leaves the same way.
 const erased=Boolean(view.error)&&(classifyErasureError(view.error,'preview').type==='gone'||view.error?.data?.code==='NOT_FOUND');
 useEffect(()=>{if(erased)router.replace('/app/positioning');},[erased,router]);
 const path=runtimePathChoice({viewSettled:Boolean(view.data)||Boolean(view.error),scopeKind:view.data?.scope?.kind});
 if(path==='loading')return <p>正在读取工作…</p>;
 if(path==='turn')return <TurnWorkspace sessionId={routeSession}/>;
 if(path==='work')return <WorkItemWorkspace sessionId={routeSession} workItemId={view.data!.scope!.workItemId}/>;
 return <main className="p-6"><p role="alert">暂时无法读取这项工作。</p><Button variant="outline" onClick={()=>void view.refetch()}>重新读取</Button></main>;
}
