'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect,useState,useRef,useMemo } from 'react';
import { Bot,User,Send,Plus,MessageSquare,Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';

type VideoOperation={workItemId:string;script:{requestId:string;executionId:string;expectedVersion:number};followup:{requestId:string;input:string;selection:{kind:'skill';moduleId:string;revisionId:string};executionId?:string};package:{requestId:string;expectedStoryboardVersion:number;expectedEditingVersion:number};sourceScriptId?:string};

export default function RuntimePage(){
 const [sessionId,setSession]=useState(''),[input,setInput]=useState(''),[selection,setSelection]=useState(''),[error,setError]=useState('');
 useEffect(()=>{const id=new URL(location.href).searchParams.get('session');if(id)setSession(id);},[]);
 const choices=trpc.runtime.choices.useQuery(sessionId?{sessionId}:undefined,{placeholderData:previous=>previous});
 const view=trpc.runtime.view.useQuery({sessionId},{enabled:Boolean(sessionId),refetchInterval:5000});
 const saved=trpc.opc.workResults.useQuery({sessionId},{enabled:Boolean(sessionId&&view.data?.scope?.kind==='work_item')});
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{enabled:Boolean(sessionId&&view.data?.scope?.kind==='work_item')});
 const saveWork=trpc.opc.saveWorkResult.useMutation();
 const saveContent=trpc.opc.saveContentResult.useMutation(),savePackage=trpc.opc.saveVideoPackage.useMutation();
 const start=trpc.runtime.start.useMutation(),prepare=trpc.runtime.prepare.useMutation(),execute=trpc.runtime.execute.useMutation(),cancel=trpc.runtime.cancel.useMutation();
 const [videoBusy,setVideoBusy]=useState(false);
 const busy=start.isPending||prepare.isPending||execute.isPending||videoBusy;
 const ordinary=choices.data?.models[0]?.id??'';
 const activeSelection=selection||ordinary;
 const end=useRef<HTMLDivElement>(null);
 const workItem=useMemo(()=>{
  const id=view.data?.scope?.kind==='work_item'?view.data.scope.workItemId:'';
  for(const business of library.data?.businesses??[])for(const account of business.accounts??[])for(const item of account.items??[])if(item.workItemId===id)return {...item,businessName:business.name,platform:account.platform,account:account.account,stage:account.stage};
  return null;
 },[library.data,view.data?.scope]);
 const versions=(workItem?.content??[]) as Array<{id:string;kind:string;version:number;status:string;body:string}>;
 const latest=(kind:string)=>versions.filter(v=>v.kind===kind).reduce((n,v)=>Math.max(n,v.version),0);
 useEffect(()=>{end.current?.scrollIntoView({block:'end'});},[view.data?.executions?.length,busy]);
 async function open(){setError('');try{
  const url=new URL(location.href),requestId=url.searchParams.get('start')??crypto.randomUUID();url.search='';url.searchParams.set('start',requestId);history.replaceState(null,'',url);
  const result=await start.mutateAsync({requestId,scope:{kind:'positioning_draft'}});
  url.search='';url.searchParams.set('session',result.sessionId);history.replaceState(null,'',url);setSession(result.sessionId);
 }catch{setError('建立草稿失败。再次点击会恢复同一次开始请求。');}}
 async function send(){setError('');try{
  const chosen=choices.data?.skills.find(s=>'skill:'+s.moduleId===activeSelection);
  const selected=chosen?{kind:'skill' as const,moduleId:chosen.moduleId,revisionId:chosen.revisionId}:activeSelection.startsWith('auto:')?{kind:'auto' as const,modelId:activeSelection.slice(5)}:{kind:'ordinary' as const,modelId:activeSelection};
  const url=new URL(location.href),requestId=url.searchParams.get('request')??crypto.randomUUID();url.searchParams.set('request',requestId);history.replaceState(null,'',url);
  const admitted=await prepare.mutateAsync({sessionId,requestId,input,selection:selected,network:'deny',sources:[]});
  url.searchParams.delete('request');history.replaceState(null,'',url);
  setInput('');await execute.mutateAsync({executionId:admitted.executionId});await view.refetch();
 }catch{setError('请求状态待核实。请读取原任务状态，不要重新发送相同内容。');await view.refetch();}}
 const videoKey=sessionId?'opc-video-operation:'+sessionId:'';
 const videoAttempt=useRef(false);
 function storeVideo(op:VideoOperation){localStorage.setItem(videoKey,JSON.stringify(op));}
 async function runVideo(initial:VideoOperation){
  if(!videoKey||videoBusy)return;setVideoBusy(true);setError('');
  try{await navigator.locks.request(videoKey,async()=>{
   const frozen=localStorage.getItem(videoKey);const op:VideoOperation=frozen?JSON.parse(frozen):initial;
   if(op.workItemId!==workItem?.workItemId)throw new Error('OPC_REQUEST_CONFLICT');storeVideo(op);
   if(!op.sourceScriptId){const script=await saveContent.mutateAsync({workItemId:op.workItemId,requestId:op.script.requestId,expectedVersion:op.script.expectedVersion,kind:'script',status:'final',executionId:op.script.executionId,sourceContentId:null});op.sourceScriptId=script.id;storeVideo(op);await library.refetch();}
   let packageExecutionId=op.followup.executionId;
   if(!packageExecutionId){const admitted=await prepare.mutateAsync({sessionId,requestId:op.followup.requestId,input:op.followup.input,selection:op.followup.selection,network:'deny',sources:[]});packageExecutionId=admitted.executionId;op.followup.executionId=packageExecutionId;storeVideo(op);}
   if(!packageExecutionId||!op.sourceScriptId)throw new Error('OPC_CONTENT_PENDING');
   await execute.mutateAsync({executionId:packageExecutionId});
   await savePackage.mutateAsync({workItemId:op.workItemId,requestId:op.package.requestId,executionId:packageExecutionId,sourceScriptId:op.sourceScriptId,expectedStoryboardVersion:op.package.expectedStoryboardVersion,expectedEditingVersion:op.package.expectedEditingVersion});
   localStorage.setItem(videoKey+':completed:'+op.package.requestId,JSON.stringify(op));localStorage.removeItem(videoKey);await Promise.all([view.refetch(),library.refetch()]);
  });}catch(cause){const message=cause instanceof Error?cause.message:'';setError(message.includes('OPC_CONTENT_RESPONSE_INVALID')?'分镜回复格式未通过保存校验，口播稿定稿已保留；请在原对话要求 Agent 重新整理。':'视频工作请求状态待核实。完整原请求已保留，刷新后会恢复同一次定稿与生成。');}finally{setVideoBusy(false);}
 }
 async function finalizeAndContinue(executionId:string){
  if(!workItem||!choices.data)return;const skill=choices.data.skills.find(s=>'skill:'+s.moduleId===activeSelection);if(!skill){setError('请选择当前选题可用的 Skill，再定稿口播稿。');return;}
  const op:VideoOperation={workItemId:workItem.workItemId,script:{requestId:crypto.randomUUID(),executionId,expectedVersion:latest('script')},followup:{requestId:crypto.randomUUID(),input:'[OPC_VIDEO_PACKAGE_V1] 基于资料中已定稿的口播稿，直接给出对应分镜和剪辑建议。只返回严格 JSON 对象，且只含 storyboard 与 editing 两个字符串字段；不要生成图片、视频或执行发布。',selection:{kind:'skill',moduleId:skill.moduleId,revisionId:skill.revisionId}},package:{requestId:crypto.randomUUID(),expectedStoryboardVersion:latest('storyboard'),expectedEditingVersion:latest('editing')}};storeVideo(op);await runVideo(op);
 }
 useEffect(()=>{if(!videoKey||videoAttempt.current||!workItem||!view.data)return;const raw=localStorage.getItem(videoKey);if(!raw)return;videoAttempt.current=true;void runVideo(JSON.parse(raw));
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[videoKey,workItem?.workItemId,view.data]);
 async function stop(executionId:string){setError('');try{await cancel.mutateAsync({executionId});await view.refetch();}catch{setError('取消状态待核实，请读取原任务。');}}
 async function recover(executionId:string){setError('');try{await execute.mutateAsync({executionId});await view.refetch();}catch{setError('暂时无法恢复，请保留原任务。');}}
 const executions=view.data?.executions as Array<{executionId:string;state:string;input:string|null;body:string|null;primaryBody:string|null;organizerComplete:boolean|null;skillExecution:boolean;needsTask:boolean;unavailableReason:string|null;contentAvailable:boolean}>|undefined;
 return <main className="flex h-dvh min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
  <header className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-primary)] px-4 sm:px-6">
   <div className="flex items-center gap-3"><MessageSquare className="h-5 w-5 text-[var(--color-primary)]"/><div><h1 className="font-medium">{workItem?.title??'工作对话'}</h1><p className="text-xs text-[var(--text-tertiary)]">{workItem?`${workItem.businessName} · ${workItem.platform}/${workItem.account}`:(choices.data?.mode??view.data?.mode)==='staging_test'?'Staging 真实对话测试':'本地模拟体验'}</p></div></div>
   {workItem?<Link className="underline" href="/library">返回资料库</Link>:<Button variant="outline" disabled={busy||!choices.data||Boolean(input.trim())} onClick={open}><Plus className="mr-2 h-4 w-4"/>新建定位草稿</Button>}
  </header>
  <p className="shrink-0 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 text-center text-sm text-[var(--text-secondary)]">{(choices.data?.mode??view.data?.mode)==='staging_test'?'当前使用真实模型并消耗测试预算；仅处理你提供的资料，未开放联网研究。':'这里返回固定的模拟回复，用于体验发送、刷新和恢复记录，不能回答真实问题，也不会调用付费模型。'}</p>
  {(choices.error||view.error)&&<p role="alert" className="p-4 text-center">当前环境不可用，或你无权访问此工作。</p>}
  <div className="min-h-0 flex-1 overflow-y-auto" aria-label="对话记录">
   {!executions?.length&&<div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center px-6 py-12 text-center"><Bot className="mb-4 h-9 w-9 text-[var(--color-primary)]"/><h2 className="text-2xl font-semibold">开始一段对话</h2><p className="mt-3 text-sm text-[var(--text-tertiary)]">{sessionId?'普通对话已默认选好。输入一条消息，发送后可刷新查看记录。':'点击右上角“新建定位草稿”，开始体验。'}</p></div>}
   <section className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">{executions?.map(e=><article key={e.executionId} className="space-y-4">
    {e.input&&<div className="flex justify-end gap-3"><p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-secondary)] px-4 py-3 text-[var(--bg-primary)]">{e.input}</p><User className="mt-3 h-5 w-5 shrink-0 text-[var(--text-secondary)]"/></div>}
    <div className="flex items-start gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--bg-primary)]"><Bot className="h-4 w-4"/></div><div className="min-w-0 max-w-[85%] rounded-2xl rounded-bl-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3">
     <p className="whitespace-pre-wrap break-words">{e.contentAvailable?(e.body??e.primaryBody??'正在核实结果，请保留原任务。'):'来源已不可用，暂不展示此内容。'}</p>
     {e.primaryBody&&!e.organizerComplete&&<p role="status" className="mt-2 text-sm">主回复已保存，附属整理未完成。</p>}
     {view.data?.scope?.kind==='work_item'&&e.state==='completed'&&e.skillExecution&&<div className="mt-3 flex flex-wrap gap-2"><Button disabled={busy||!workItem} onClick={()=>finalizeAndContinue(e.executionId)}>定稿口播稿并生成分镜与剪辑建议</Button><Button variant="outline" disabled={saveWork.isPending} onClick={async()=>{try{await saveWork.mutateAsync({executionId:e.executionId});await saved.refetch();}catch{setError('这条记录尚不能保存为普通 Skill 成果。');}}}>另存普通成果</Button></div>}
     {e.state==='cancelled'&&<p role="status" className="mt-2 text-sm">已取消剩余执行，保留原记录。</p>}
     {e.state==='cost_pending'&&<p role="status" className="mt-2 text-sm">费用待核实；恢复只核对原调用。</p>}
     {e.needsTask&&<p className="mt-2 text-sm">当前入口暂不支持这个 Skill 的任务选择。可取消剩余执行后使用普通对话。</p>}
     {e.unavailableReason==='latest_unavailable'&&<p className="mt-2 text-sm">本次未取得搜索资料，无法提供已核实的最新信息。</p>}
     {e.state!=='completed'&&e.state!=='cancelled'&&<div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={()=>recover(e.executionId)}>恢复原任务</Button><Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={()=>stop(e.executionId)}>取消剩余执行</Button></div>}
    </div></div>
   </article>)}{versions.map(v=><article key={v.id} className="rounded-xl border border-[var(--border-primary)] p-4"><h2>{v.kind==='script'?'口播稿':v.kind==='storyboard'?'分镜':v.kind==='editing'?'剪辑建议':'简报'} · 第 {v.version} 版 · {v.status==='final'?'已定稿':'草稿'}</h2><p className="mt-2 whitespace-pre-wrap">{v.body}</p></article>)}{saved.data?.map((a:{artifactId:string;version:number;body:string|null})=><article key={a.artifactId} className="rounded-xl border border-[var(--border-primary)] p-4"><h2>其他 Skill 成果 · 第 {a.version} 版</h2><p className="whitespace-pre-wrap">{a.body??'来源不可用'}</p></article>)}{busy&&<p role="status" className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin"/>正在处理，请稍候…</p>}<div ref={end}/></section>
  </div>
  {sessionId&&<footer className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"><div className="mx-auto max-w-3xl">
   <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm"><label>对话方式 <select aria-label="对话方式" value={activeSelection} disabled={busy||Boolean(view.data?.activeExecution)} onChange={e=>setSelection(e.target.value)} className="ml-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2"><option value={ordinary}>普通对话</option>{choices.data?.skills.map(s=><option key={s.moduleId} value={'skill:'+s.moduleId}>{view.data?.scope?.kind==='work_item'?s.name:'Skill 演示'}</option>)}</select></label><span className="text-xs text-[var(--text-tertiary)]" role="status">已保存独立工作记录，刷新后可继续。</span></div>
   <div className="flex items-end gap-2 rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 focus-within:border-[var(--color-primary)]">
    <Textarea aria-label="消息" placeholder="输入消息…" value={input} disabled={busy||Boolean(view.data?.activeExecution)} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!busy&&activeSelection&&input.trim()&&!view.data?.activeExecution)void send();}}} className="min-h-12 max-h-36 flex-1 resize-none border-0 bg-transparent px-2 focus-visible:ring-0" rows={2}/>
    <Button aria-label="发送" className="h-10 w-10 shrink-0 rounded-xl p-0" disabled={busy||!activeSelection||!input.trim()||Boolean(view.data?.activeExecution)} onClick={send}><Send className="h-4 w-4"/></Button>
   </div><p className="mt-2 text-center text-xs text-[var(--text-tertiary)]">Enter 发送 · Shift + Enter 换行</p>
  </div></footer>}{error&&<p role="alert" className="shrink-0 p-3 text-center text-sm">{error}</p>}
 </main>;
}
