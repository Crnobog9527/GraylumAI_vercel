/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import {useRef,useState} from 'react';
import {trpc} from '@/trpc/client';
import {Button} from '@/components/ui/button';
export function SliceStartWork({onCreated}:{onCreated:(projectId:string,roundId:string,pairId:string)=>Promise<void>}){
 const utils=trpc.useUtils(),sources=trpc.agentSlice.sources.useQuery(undefined,{retry:false,refetchOnWindowFocus:true});
 const [selection,setSelection]=useState(''),[title,setTitle]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const locked=useRef(false),request=useRef<Parameters<typeof utils.client.agentSlice.continueWork.mutate>[0]|null>(null);
 const create=async()=>{if(locked.current)return;const source=sources.data?.find(s=>s.sourceVersionId+':'+s.pairId===selection);
  if(!request.current){if(!source||!title.trim())return;const id=crypto.randomUUID();request.current={requestId:id,projectId:id,sourceVersionId:source.sourceVersionId,pairId:source.pairId,purpose:'script',title:title.trim()};}
  locked.current=true;setBusy(true);setPending(true);setError('');
  try{const payload=request.current;const result=await utils.client.agentSlice.continueWork.mutate(payload);await onCreated(result.projectId,result.roundId,payload.pairId);request.current=null;setPending(false);setTitle('');}
  catch{setError('暂时无法确认创建结果，请重试。重试会找回同一作品。');}
  finally{locked.current=false;setBusy(false);}
 };
 return <details className="mt-3"><summary className="cursor-pointer">基于定位报告新建脚本</summary><div className="mt-3 space-y-3">
 {sources.isPending&&<p role="status">正在读取定位报告…</p>}
 {sources.error&&<p role="alert">暂时无法读取定位报告。<Button variant="ghost" onClick={()=>void sources.refetch()}>重试读取</Button></p>}
 {sources.data?.length===0&&<p>当前没有可用于此入口的正式定位报告。其他聊天和既有 Skill 入口不受影响。</p>}
 {!!sources.data?.length&&<><label className="block">选择定位报告与版本<select aria-label="选择定位报告与版本" disabled={busy||pending} value={selection} onChange={e=>setSelection(e.target.value)} className="block w-full bg-[var(--bg-secondary)] p-2"><option value="">请选择一份正式报告</option>{sources.data.map(s=><option key={s.sourceVersionId+':'+s.pairId} value={s.sourceVersionId+':'+s.pairId}>{s.account??'我的账号'} · {s.title} · v{s.version} → {s.skillTitle}</option>)}</select></label>
 <label className="block">新脚本名称<input aria-label="新脚本名称" maxLength={160} disabled={busy||pending} value={title} onChange={e=>setTitle(e.target.value)} className="block w-full bg-[var(--bg-secondary)] p-2" placeholder="例如：这周的口播脚本 A"/></label></>}
 <Button disabled={busy||(!pending&&(!selection||!title.trim()))} onClick={()=>void create()}>{busy?'正在创建…':pending?'重试创建原作品':'创建独立脚本'}</Button>
 <p className="text-xs">每次明确新建都是独立作品，固定引用所选版本。修改已有作品，请从其正式报告开始修订。</p>{error&&<p role="alert">{error}</p>}
 </div></details>;
}
