/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import {useEffect,useRef,useState} from 'react';
import {trpc} from '@/trpc/client';
import {Button} from '@/components/ui/button';
import {ReferenceContent} from './reference-content';
import type {inferRouterOutputs} from '@trpc/server';
import type {AppRouter} from '@repo/api/src/root';
type Result=inferRouterOutputs<AppRouter>['workbench']['search'];
type Request={projectId:string;roundId:string;stepId:string;requestId:string;query:string};
export function SearchReferences({projectId,roundId,stepId,disabled,readOnly,run,reload}:{projectId:string;roundId:string;stepId:string;disabled:boolean;readOnly:boolean;run:(action:()=>Promise<void>)=>Promise<void>;reload:()=>Promise<void>}){
 const api=trpc.useUtils().client.workbench;
 const [query,setQuery]=useState(''),[pending,setPending]=useState<Request|null>(null),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[ready,setReady]=useState(false);
 const inFlight=useRef(false),alive=useRef(true),key=`graylum-search:${projectId}:${roundId}:${stepId}`;
 useEffect(()=>{alive.current=true;try{const v=JSON.parse(sessionStorage.getItem(key)??'null');if(v?.projectId===projectId&&v.roundId===roundId&&v.stepId===stepId&&typeof v.query==='string'&&v.query.length<=200&&typeof v.requestId==='string'&&/^[a-f0-9-]{36}$/.test(v.requestId)){setPending(v);setQuery(v.query);}}catch{}setReady(true);return()=>{alive.current=false;};},[key,projectId,roundId,stepId]);
 async function search(){
  if(disabled||!ready||inFlight.current||(readOnly&&!pending))return;
  inFlight.current=true;
  const request=pending??{projectId,roundId,stepId,requestId:crypto.randomUUID(),query:query.trim()};
  // Persist the identity before dispatch; storage failure must not risk a paid replay.
  try{sessionStorage.setItem(key,JSON.stringify(request));}catch{inFlight.current=false;setError('无法保存搜索记录，请检查浏览器存储后再试。');return;}
  setPending(request);setError('');
  try{await run(async()=>{try{
   const value=await api.search.mutate(request);
   if(!alive.current)return;
   setResult(value);
   if(!readOnly&&value.state==='succeeded'&&value.result?.objects.length){
    await api.execute.mutate({action:'researchEvidence',projectId,roundId,stepId,query:request.query,requestId:request.requestId,planId:request.requestId,operationId:request.requestId});
    if(alive.current){await reload();if(alive.current)setResult({...value,result:null});}
   }
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:'搜索暂未完成，请恢复本次查询。');}});}finally{inFlight.current=false;}
 }
 return <section aria-label="网页搜索" className="my-3 space-y-2 rounded-lg border border-[var(--border-primary)] p-3">
  <p className="font-medium">搜索公开网页</p>
  <p className="text-xs text-[var(--text-tertiary)]">只发送你输入的查询，不附带聊天内容或私有资料。成功执行按本次预扣的联网附加积分结算；没有匹配结果也属于已执行搜索。</p>
  <input aria-label="网页搜索关键词" maxLength={200} value={query} disabled={disabled||readOnly||!!pending||!ready} onChange={e=>setQuery(e.target.value)} placeholder="输入要查找的信息…" className="w-full rounded bg-[var(--bg-secondary)] p-2"/>
  <Button size="sm" disabled={disabled||!ready||!query.trim()||(readOnly&&!pending)} onClick={()=>void search()}>{pending?'恢复本次查询':'搜索网页'}</Button>
  {pending&&result?.state!=='succeeded'&&result?.state!=='failed'&&<Button size="sm" variant="outline" disabled={disabled} onClick={()=>void run(async()=>{try{const value=await api.cancelSearch.mutate(pending);if(!alive.current)return;if(!value.cancelled){setError('搜索已发送，不能作为未发送请求取消。请保留并恢复本次查询。');return;}sessionStorage.removeItem(key);setPending(null);setResult(null);setError('');}catch(e){if(alive.current)setError(e instanceof Error?e.message:'取消暂未完成，请保留本次记录。');}})}>取消未发送查询</Button>}
  {!readOnly&&(result?.state==='succeeded'||result?.state==='failed')&&<Button size="sm" variant="outline" disabled={disabled} onClick={()=>{try{sessionStorage.removeItem(key);}catch{setError('无法更新搜索记录，请稍后再试。');return;}setPending(null);setResult(null);setQuery('');setError('');}}>新搜索</Button>}
  {result?.searchEvidence&&<p className="text-xs">已验证执行 {result.searchEvidence.queryCount} 次公开网页查询。</p>}
  {error&&<p role="alert" className="text-sm">{error}</p>}
  {pending&&!result&&!error&&<p className="text-xs">查询记录已保留，可恢复本次查询。</p>}
  {result?.state==='succeeded'&&result.result&&(result.result.objects.length?<ReferenceContent payload={{projection:'research-result',result:result.result}}/>:<p className="text-sm">未找到匹配结果，可换一个查询。</p>)}
  {result?.state==='failed'&&<p className="text-sm">本次搜索失败，预扣积分已退回。你可以发起新搜索。</p>}
  {result&&result.state!=='succeeded'&&result.state!=='failed'&&<p className="text-sm">本次搜索尚无可用结果。请恢复原查询查看状态，系统不会自动重复搜索。</p>}
  {result?.state==='succeeded'&&!result.result&&!result.restricted&&<p className="text-sm">已加入参考资料，可勾选关联到本步骤。</p>}
  {result?.restricted&&<p className="text-sm">搜索资料已受限，不能再次使用。</p>}
 </section>;
}
