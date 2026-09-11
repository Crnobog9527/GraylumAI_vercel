/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import {useEffect, useRef, useState} from 'react';
import {trpc} from '@/trpc/client';
import {Button} from '@/components/ui/button';
import type {ArtifactReport} from '@repo/api/src/services/artifacts/public';

/** Real report entry: uses the existing authenticated artifact and chat routes. */
export function ReportWorkActions({report}:{report:ArtifactReport}) {
  const api=trpc.useUtils().client.workbench;
  const [choices,setChoices]=useState<Array<{id:string;label:string}>>([]);
  const [title,setTitle]=useState(''),[config,setConfig]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const pending=useRef<Parameters<typeof api.createWork.mutate>[0]|null>(null);
  const locked=useRef(false);
  useEffect(()=>{
    let current=true;setChoices([]);setConfig('');setError('');setLoading(true);pending.current=null;
    if(report.available&&report.id) void api.referenceChoices.query({sourceVersionId:report.id}).then(c=>{if(current){setChoices(c);setConfig(c[0]?.id??'');setLoading(false);}}).catch(()=>{if(current){setLoading(false);setError('引用入口暂时无法读取，请重新打开报告。');}});
    return ()=>{current=false;};
  },[api,report.id,report.available]);
  if(!report.available||!report.id)return null;
  return <section aria-label="基于定位创作" className="my-4 space-y-3 rounded-xl border border-yellow-500/30 p-4">
    <p>基于这份正式定位 v{report.version} 创作独立脚本</p>
    {error&&<p role="alert">{error}</p>}
    {loading?<p>正在读取可用脚本…</p>:error&&!choices.length?null:!choices.length?<p className="text-sm text-zinc-400">尚无可用的脚本引用配置。</p>:<>
      <label className="block">脚本功能<select aria-label="脚本功能" value={config} disabled={busy} onChange={e=>{setConfig(e.target.value);pending.current=null;}} className="ml-2 bg-zinc-900">{choices.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <input aria-label="新作品名称" placeholder="为这份脚本起个名字" value={title} maxLength={160} disabled={busy} onChange={e=>{setTitle(e.target.value);pending.current=null;}} className="w-full rounded border border-white/20 bg-transparent p-2"/>
      <Button disabled={busy||!title.trim()} onClick={()=>{void (async()=>{
        if(locked.current)return;locked.current=true;setBusy(true);setError('');
        try{
          if(!pending.current){const id=crypto.randomUUID();pending.current={projectId:id,roundId:id,requestId:id,sourceVersionId:report.id!,configId:config,title:title.trim()};}
          const created=await api.createWork.mutate(pending.current);
          const binding=await api.chatEnter.mutate({...created,requestId:pending.current.requestId});
          window.location.assign(`/chat?conversation=${binding.conversationId}`);
        }catch{setError('暂未完成，请重试；会继续同一份作品。');}
        finally{locked.current=false;setBusy(false);}
      })();}}>{busy?'正在打开…':'基于此定位创作脚本'}</Button>
    </>}
  </section>;
}

export function WorkSource({projectId,roundId,title,canRevise,onRevised}:{projectId:string;roundId:string;title:string;canRevise:boolean;onRevised:(roundId:string)=>Promise<void>}) {
  const api=trpc.useUtils().client.workbench;
  const [source,setSource]=useState<Awaited<ReturnType<typeof api.workSource.query>>>(null);
  const [versions,setVersions]=useState<Array<{roundId:string;version:number|null}>>([]);
  const [selected,setSelected]=useState(''),[text,setText]=useState('正在读取定位来源…'),[busy,setBusy]=useState(false);
  const pending=useRef<Parameters<typeof api.createWork.mutate>[0]|null>(null),lock=useRef(false);
  useEffect(()=>{let current=true;setSource(null);setVersions([]);setText('正在读取定位来源…');pending.current=null;
    void api.workSource.query({projectId,roundId}).then(async s=>{
      const rounds=s?await api.rounds.query({projectId:s.sourceProjectId}):[];
      if(current){setSource(s);setSelected(s?.sourceRoundId??'');setVersions(rounds.filter(r=>r.state==='published'));setText(s?`已固定引用：定位正式 v${s.version}`:'');}
    }).catch(()=>{if(current)setText('定位来源暂不可用，相关内容不可使用。');});return()=>{current=false;};
  },[api,projectId,roundId]);
  return <section className="my-3 space-y-2 text-sm" aria-label="作品定位来源"><p aria-live="polite">{text}</p>
    {source&&canRevise&&<>
      <label>修订所用定位版本<select aria-label="修订所用定位版本" className="ml-2 bg-zinc-900" disabled={busy} value={selected} onChange={e=>{setSelected(e.target.value);pending.current=null;}}>{versions.map(v=><option key={v.roundId} value={v.roundId}>定位 v{v.version}</option>)}</select></label>
      <p>新修订不会修改已保存版本；采用不同定位版本会从空工作稿开始。</p>
      <Button disabled={busy} onClick={()=>{void(async()=>{
        if(lock.current)return;lock.current=true;setBusy(true);
        try{
          if(!pending.current){const report=await api.report.query({projectId:source.sourceProjectId,roundId:selected});if(!report.available||!report.id)throw new Error();const id=crypto.randomUUID();pending.current={projectId,roundId:id,requestId:id,fromRoundId:roundId,sourceVersionId:report.id,configId:source.configId,title};}
          const created=await api.createWork.mutate(pending.current);await onRevised(created.roundId);
        }catch{setText('修订暂未完成，请重试；原作品已保留。');}finally{lock.current=false;setBusy(false);}
      })();}}>创建本作品的新修订</Button>
    </>}
  </section>;
}
