/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import {useEffect,useRef,useState} from 'react';
import type {inferRouterOutputs} from '@trpc/server';
import type {AppRouter} from '@repo/api/src/root';
import {trpc} from '@/trpc/client';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog';
export type SliceWork=inferRouterOutputs<AppRouter>['agentSlice']['targets'][number];
export type SliceTarget=SliceWork&{stepId:string;stepTitle:string};
export function SliceArtifact({target,works,candidate,onChanged,onContinue}:{target:SliceTarget;works:SliceWork[];candidate?:{candidateId:string;body:string;adoptable:boolean};onChanged:()=>void;onContinue:(projectId:string,roundId:string,pairId:string)=>Promise<void>}){
 const utils=trpc.useUtils(),scope={projectId:target.projectId,roundId:target.roundId};
 const query=trpc.workbench.read.useQuery(scope,{retry:false,refetchOnWindowFocus:true});
 const [drafts,setDrafts]=useState<Record<string,{body:string;version:number;id:string}>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[returnRound,setReturnRound]=useState('');
 const [report,setReport]=useState<inferRouterOutputs<AppRouter>['workbench']['report']|null>(null);
 const requests=useRef(new Map<string,string>()),locked=useRef(false);
 useEffect(()=>{setReport(null);},[target.projectId,target.roundId]);
 useEffect(()=>{if(!report)return;let alive=true;
  const refresh=()=>{if(document.visibilityState!=='visible')return;void utils.client.workbench.report.query(scope).then(value=>{if(alive)setReport(value);}).catch(()=>{if(alive)setReport({available:false});});};
  document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);
  return()=>{alive=false;document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);};
 },[!!report,target.projectId,target.roundId,utils.client]);

 const key=target.roundId+':'+target.stepId,st=query.error?undefined:query.data?.steps[target.stepId],draft=drafts[key];
 const requestId=(payload:unknown)=>{const k=JSON.stringify(payload);let id=requests.current.get(k);if(!id){id=crypto.randomUUID();requests.current.set(k,id);}return id;};
 const action=async(fn:()=>Promise<unknown>)=>{if(locked.current)return;locked.current=true;setBusy(true);setError('');try{await fn();await query.refetch();onChanged();}catch{setError('操作未完成。请重新读取状态后重试；你的编辑仍保留。');}finally{locked.current=false;setBusy(false);}};
 const send=async(payload:Parameters<typeof utils.client.workbench.execute.mutate>[0])=>utils.client.workbench.execute.mutate(payload);
 const clearDraft=()=>setDrafts(current=>{if(current[key]?.id!==draft?.id)return current;const next={...current};delete next[key];return next;});
 const save=()=>{if(!st||!draft)return;const payload={action:'save' as const,...scope,stepId:target.stepId,expectedVersion:draft.version,body:draft.body,evidenceIds:st.evidenceIds};void action(async()=>{await send({...payload,requestId:requestId(payload)});clearDraft();});};
 const adopt=()=>{if(!st||!candidate)return;const payload={action:'saveCandidate' as const,...scope,stepId:target.stepId,expectedVersion:st.version,body:candidate.body,candidateId:candidate.candidateId};void action(()=>send({...payload,requestId:requestId(payload)}));};
 const confirm=()=>{if(!st)return;const payload={action:'confirm' as const,...scope,stepId:target.stepId,expectedVersion:st.version,expectedReviewVersion:st.reviewVersion};void action(()=>send({...payload,requestId:requestId(payload)}));};
 const ready=!!query.data&&Object.values(query.data.steps).every(s=>s.valid&&s.confirmationId);
 const publish=()=>{if(!query.data)return;const payload={action:'publish' as const,...scope,expectedSteps:Object.fromEntries(Object.entries(query.data.steps).map(([id,s])=>[id,{version:s.version,reviewVersion:s.reviewVersion}]))};void action(async()=>{await send({...payload,requestId:requestId(payload)});setReport(await utils.client.workbench.report.query(scope));});};
 const continuation=()=>void action(async()=>{
  const formal=await utils.client.workbench.report.query(scope);if(!formal.available||!formal.id)throw new Error('unavailable');
  const back=works.find(w=>w.roundId===returnRound&&w.purpose==='script'&&w.state==='published'&&w.account===target.account&&w.pairId===target.pairId);
  if(target.purpose==='title'&&!back)throw new Error('select a script');
  const identity={sourceVersionId:formal.id,pairId:target.pairId,purpose:target.purpose==='script'?'title' as const:'script' as const,title:back?.title??target.title+' · 标题',...(back?{fromRoundId:back.roundId}:{})};
  const id=requestId(identity);const next=await utils.client.agentSlice.continueWork.mutate({...identity,requestId:id,projectId:back?.projectId??id});
  await onContinue(next.projectId,next.roundId,target.pairId);
 });
 return <aside aria-label="当前作品成果" className="w-full space-y-4 border-l border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 lg:w-80 lg:shrink-0 lg:overflow-y-auto">
 <h2 className="font-semibold">{target.title}</h2><p className="text-xs">引用：{target.sourceTitle}{target.sourceVersion?` · 正式 v${target.sourceVersion}`:" · 尚未选择"}</p><p className="text-sm">{target.stepTitle}</p>
 {query.isPending&&<p>正在读取成果…</p>}{query.error&&<p role="alert">成果暂时无法读取。</p>}
 {st&&<>{st.body===null?<p>这份内容目前不可访问。</p>:<>
 {candidate&&query.data?.state==='draft'&&(candidate.adoptable||candidate.body!==st.body)&&<div className="space-y-2"><p>本轮已整理好一份成果，可采用后修改、确认。</p><Button disabled={busy||!!draft||!candidate.adoptable} onClick={adopt}>采用本轮成果</Button></div>}
 <textarea aria-label="本步骤成果" disabled={busy||query.data?.state!=='draft'} value={draft?.body??st.body} maxLength={query.data?.workflow.steps.find(s=>s.id===target.stepId)?.maxLength??20000} onChange={e=>setDrafts(current=>({...current,[key]:{body:e.target.value,version:current[key]?.version??st.version,id:crypto.randomUUID()}}))} className="min-h-48 w-full rounded-lg bg-[var(--bg-secondary)] p-3"/>
 {draft&&<><Button disabled={busy} onClick={save}>保存修改</Button><Button variant="ghost" disabled={busy} onClick={clearDraft}>放弃本地修改</Button></>}
 {query.data?.state==='draft'&&<Button disabled={busy||!!draft||!st.body.trim()||st.valid} onClick={confirm}>{st.valid?'本步骤已确认':'确认本步骤成果'}</Button>}
 </>}</>}
 {query.data?.state==='draft'&&ready&&<section className="space-y-2 rounded-lg border border-[var(--accent-primary)] p-3"><p>所有步骤已确认，下一步保存为正式版本。</p><Button disabled={busy||!!draft} onClick={publish}>发布已确认版本</Button></section>}
 {query.data?.state==='published'&&<section className="space-y-3"><p>正式版本已保存</p><Button variant="outline" disabled={busy} onClick={()=>void action(async()=>setReport(await utils.client.workbench.report.query(scope)))}>查看正式报告</Button>
 {target.purpose==='title'&&<label className="block">带回哪份脚本<select aria-label="带回哪份脚本" value={returnRound} onChange={e=>setReturnRound(e.target.value)} className="w-full bg-[var(--bg-secondary)] p-2"><option value="">选择已保存的脚本版本</option>{works.filter(w=>w.purpose==='script'&&w.state==='published'&&w.account===target.account&&w.pairId===target.pairId).map(w=><option key={w.roundId} value={w.roundId}>{w.title} · v{w.version}</option>)}</select></label>}
 <Button disabled={busy||(target.purpose==='title'&&!returnRound)} onClick={continuation}>{target.purpose==='script'?'用这版脚本创作标题':'采用这些标题，修订脚本'}</Button><p className="text-xs">将固定引用当前正式版本，继续留在本对话中。</p></section>}
 {error&&<p role="alert">{error}</p>}
 <Dialog open={!!report} onOpenChange={open=>{if(!open)setReport(null);}}><DialogContent className="max-h-[85dvh] max-w-4xl overflow-y-auto"><DialogTitle>{report?.report?.title??'正式报告'}</DialogTitle>{report?.available?report.report?.sections.map(section=><section key={section.stepId} className="space-y-3"><h3 className="font-semibold">{section.title}</h3><p className="whitespace-pre-wrap break-words leading-7">{section.body}</p></section>):<p>这份报告目前不可访问。</p>}</DialogContent></Dialog>
 </aside>;
}
