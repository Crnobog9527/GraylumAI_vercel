'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect,useState } from 'react';
import { trpc } from '@/trpc/client';

export default function RuntimePage(){
 const [sessionId,setSession]=useState(''),[input,setInput]=useState(''),[selection,setSelection]=useState(''),[error,setError]=useState('');
 useEffect(()=>{const id=new URL(location.href).searchParams.get('session');if(id)setSession(id);},[]);
 const choices=trpc.runtime.choices.useQuery();
 const view=trpc.runtime.view.useQuery({sessionId},{enabled:Boolean(sessionId),refetchInterval:5000});
 const start=trpc.runtime.start.useMutation(),prepare=trpc.runtime.prepare.useMutation(),execute=trpc.runtime.execute.useMutation(),cancel=trpc.runtime.cancel.useMutation();
 const busy=start.isPending||prepare.isPending||execute.isPending;
 async function open(){setError('');try{
  const url=new URL(location.href),requestId=url.searchParams.get('start')??crypto.randomUUID();url.search='';url.searchParams.set('start',requestId);history.replaceState(null,'',url);
  const result=await start.mutateAsync({requestId,scope:{kind:'positioning_draft'}});
  url.search='';url.searchParams.set('session',result.sessionId);history.replaceState(null,'',url);setSession(result.sessionId);
 }catch{setError('建立草稿失败。再次点击会恢复同一次开始请求。');}}
 async function send(){setError('');try{
  const chosen=choices.data?.skills.find(s=>'skill:'+s.moduleId===selection);
  const selected=chosen?{kind:'skill' as const,moduleId:chosen.moduleId,revisionId:chosen.revisionId}:selection.startsWith('auto:')?{kind:'auto' as const,modelId:selection.slice(5)}:{kind:'ordinary' as const,modelId:selection};
  const url=new URL(location.href),requestId=url.searchParams.get('request')??crypto.randomUUID();url.searchParams.set('request',requestId);history.replaceState(null,'',url);
  const admitted=await prepare.mutateAsync({sessionId,requestId,input,selection:selected,network:'deny',sources:[]});
  url.searchParams.delete('request');history.replaceState(null,'',url);
  setInput('');await execute.mutateAsync({executionId:admitted.executionId});await view.refetch();
 }catch{setError('请求状态待核实。请读取原任务状态，不要重新发送相同内容。');await view.refetch();}}
 async function stop(executionId:string){setError('');try{await cancel.mutateAsync({executionId});await view.refetch();}catch{setError('取消状态待核实，请读取原任务。');}}
 async function recover(executionId:string){setError('');try{await execute.mutateAsync({executionId});await view.refetch();}catch{setError('暂时无法恢复，请保留原任务。');}}
 const executions=view.data?.executions as Array<{executionId:string;state:string;input:string|null;body:string|null;primaryBody:string|null;organizerComplete:boolean|null;needsTask:boolean;unavailableReason:string|null;contentAvailable:boolean}>|undefined;
 return <main className="mx-auto max-w-3xl p-6 text-foreground">
  <h1 className="text-2xl font-semibold">工作对话</h1><p className="mt-2 text-muted-foreground">隔离体验 · 使用模拟模型和测试积分</p>
  {(choices.error||view.error)&&<p role="alert" className="mt-4">当前环境不可用，或你无权访问此工作。</p>}
  <button className="my-4 rounded border border-primary px-4 py-2" disabled={busy||!choices.data} onClick={open}>新建定位草稿</button>
  {sessionId&&<><p role="status">已保存独立工作记录，刷新后可继续。</p>
   <section aria-label="对话记录" className="my-4 space-y-4">{executions?.map(e=><article key={e.executionId} className="rounded border p-4">
    <p>{e.input}</p><p className="mt-3 whitespace-pre-wrap">{e.contentAvailable?(e.body??e.primaryBody??'正在核实结果，请保留原任务。'):'来源已不可用，暂不展示此内容。'}</p>
    {e.primaryBody&&!e.organizerComplete&&<p role="status">主回复已保存，附属整理未完成。</p>}
    {e.state==='cancelled'&&<p role="status">已取消剩余执行，保留原记录。</p>}
    {e.state==='cost_pending'&&<p role="status">费用待核实；恢复只核对原调用。</p>}
    {e.state!=='completed'&&e.state!=='cancelled'&&<button disabled={busy} onClick={()=>recover(e.executionId)} className="mt-3 underline">恢复原任务</button>}
    {e.needsTask&&<p>已匹配到包含多个任务的 Skill，但当前入口尚不支持选择其任务，私有方法未执行。可取消剩余执行后使用普通对话或其他 Skill。</p>}
    {e.unavailableReason==='latest_unavailable'&&<p>本次未取得搜索资料，无法提供已核实的最新信息。</p>}
    {e.state!=='completed'&&e.state!=='cancelled'&&<button disabled={cancel.isPending} onClick={()=>stop(e.executionId)} className="ml-4 underline">取消剩余执行</button>}
   </article>)}</section>
   <label className="block">模型或 Skill<select aria-label="模型或 Skill" value={selection} onChange={e=>setSelection(e.target.value)} className="m-2 rounded border bg-background p-2">
    <option value="">请选择</option>{choices.data?.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}{choices.data?.models.map(m=><option key={'auto:'+m.id} value={'auto:'+m.id}>自动匹配 Skill · {m.name}</option>)}{choices.data?.skills.map(s=><option key={s.moduleId} value={'skill:'+s.moduleId}>{s.name}</option>)}
   </select></label>
   <label className="block">消息<textarea aria-label="消息" value={input} onChange={e=>setInput(e.target.value)} className="my-2 block min-h-28 w-full rounded border bg-background p-3"/></label>
   <button className="rounded bg-primary px-4 py-2 text-primary-foreground" disabled={busy||!selection||!input.trim()||Boolean(view.data?.activeExecution)} onClick={send}>发送</button>
  </>}{error&&<p role="alert" className="mt-4">{error}</p>}
 </main>;
}
