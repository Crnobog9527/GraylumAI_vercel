'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/trpc/client';
import styles from './content-editor.module.css';

export type ContentVersion={id:string;kind:string;version:number;status:string;title?:string|null;body:string|null;contentAvailable?:boolean;sourceContentId:string|null;executionId:string|null;requestId:string};
export type EditableItem={workItemId:string;sessionId:string;title:string;brief:string|null;contentType?:string;platform:string;account:string;sourceAvailable:boolean;content:ContentVersion[]};
type Draft={baseVersion:number;sourceContentId:string|null;title:string;body:string};
type Frozen=Draft&{workItemId:string;requestId:string;expectedVersion:number;kind:'brief'|'script';status:'draft'|'final'};
const rejected=new Set(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_CONTENT_DENIED','OPC_CONTENT_INVALID','OPC_CONTENT_SOURCE','OPC_CONTENT_BINDING']);

export function ContentEditor({item,onSaved}:{item:EditableItem;onSaved:()=>Promise<unknown>}){
 const kind=item.contentType==='video'?'script':'brief';
 const versions=useMemo(()=>item.content.filter(version=>version.kind===kind).sort((a,b)=>b.version-a.version),[item.content,kind]);
 const latest=versions[0]??null;
 const key='opc-content-draft:'+item.workItemId;
 const pendingKey='opc-content-save:'+item.workItemId;
 const [draft,setDraft]=useState<Draft|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const [history,setHistory]=useState(false);
 const saveMutation=trpc.opc.saveContentManual.useMutation();
 useEffect(()=>{
  try{
   const cached=localStorage.getItem(key);
   setDraft(cached?JSON.parse(cached) as Draft:{baseVersion:latest?.version??0,sourceContentId:latest?.id??null,title:latest?.title||item.title,body:latest?.body??''});
   setPending(Boolean(localStorage.getItem(pendingKey)));
  }catch{setError('本机未保存的编辑无法读取，请先保留当前页面内容。');}
 // A new server version must never replace local unsaved input.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[item.workItemId]);
 function change(patch:Partial<Draft>){
  if(!draft)return;
  const next={...draft,...patch};
  try{localStorage.setItem(key,JSON.stringify(next));setDraft(next);setSaved('');}
  catch{setError('无法保留未保存编辑，请检查本机存储。');}
 }
 async function save(status:'draft'|'final',offeredBody?:string){
  if(!draft||!item.sourceAvailable||latest&&latest.contentAvailable===false)return;
  const pendingRaw=localStorage.getItem(pendingKey);
  const body=(offeredBody??draft.body).trim(),title=draft.title.trim();
  if(!pendingRaw&&(!title||!body)){setError('请填写标题和正文。');return;}
  if(!pendingRaw&&(body.length>20000||title.length>160)){setError('标题或正文超出长度限制。');return;}
  if(!pendingRaw&&draft.baseVersion>(latest?.version??0)){
   setSaved('上一版已在服务端保存，正在等待读取最新历史。');return;
  }
  if(!pendingRaw&&latest?.status===status&&latest?.title===title&&latest?.body===body){
   setSaved('当前内容已经是已保存版本。');return;
  }
  setError('');setSaved('');
  try{
   await navigator.locks.request(pendingKey,async()=>{
    const raw=localStorage.getItem(pendingKey);
    const frozen:Frozen=raw?JSON.parse(raw):{...draft,body,title,workItemId:item.workItemId,requestId:crypto.randomUUID(),expectedVersion:draft.baseVersion,kind,status};
    if(!raw)localStorage.setItem(pendingKey,JSON.stringify(frozen));
    setPending(true);
    const result=await saveMutation.mutateAsync({
     workItemId:frozen.workItemId,requestId:frozen.requestId,expectedVersion:frozen.expectedVersion,
     sourceContentId:frozen.sourceContentId,kind:frozen.kind,status:frozen.status,title:frozen.title,body:frozen.body,
    }) as {id:string;version:number;status:string};
    localStorage.removeItem(pendingKey);setPending(false);
    const currentRaw=localStorage.getItem(key);
    const current:Draft=currentRaw?JSON.parse(currentRaw):draft;
    const next={...current,baseVersion:result.version,sourceContentId:result.id};
    if(current.title===frozen.title&&current.body===frozen.body){
     localStorage.removeItem(key);setDraft(next);
    }else{
     localStorage.setItem(key,JSON.stringify(next));setDraft(next);
    }
    setSaved('已在服务端保存 v'+result.version+(result.status==='final'?' · 已定稿':' · 草稿'));
    try{await onSaved();}catch{setError('版本已在服务端保存，但最新历史暂未刷新；请稍后重新打开当前工作。');}
   });
  }catch(cause){
   const code=cause instanceof Error?cause.message:'';
   if(rejected.has(code)){
    localStorage.removeItem(pendingKey);setPending(false);
    await onSaved();
    setError(code==='OPC_VERSION_CONFLICT'?'已有更新版本。你的编辑已保留，请比较历史后再明确重试。':'保存被服务端拒绝（'+code+'）。编辑仍保留。');
   }else setError('保存结果待核实。原请求已保留；请用“恢复原保存”核对，不要重复创建版本。');
  }
 }
 if(!draft)return <p className={styles.loading}>正在读取当前成果…</p>;
 return <div className={styles.editor}>
  <header><p className={styles.label}>当前成果</p><p className={styles.meta}>{item.platform} · {item.account} · {item.contentType==='video'?'口播稿':'内容创作'}</p></header>
  <div className={styles.body}>
   {!item.sourceAvailable||latest&&latest.contentAvailable===false?<p role="alert">来源已不可用，不能编辑或保存这条工作。</p>:<>
    <label>标题<input aria-label="稿件标题" value={draft.title} onChange={event=>change({title:event.target.value})} maxLength={160}/></label>
    <label>文章正文<textarea aria-label="文章正文" value={draft.body} onChange={event=>change({body:event.target.value})} maxLength={20000} placeholder="先写下草稿，保存后会形成可找回的版本。"/></label>
    <p className={styles.version}>{latest?'服务端已保存 v'+latest.version+' · '+(latest.status==='final'?'已定稿':'草稿'):'尚无已保存稿件'}</p>
    {saved&&<p role="status" className={styles.success}>{saved}</p>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {latest&&draft.baseVersion<latest.version&&!pending&&<button className={styles.rebase} onClick={()=>change({baseVersion:latest.version,sourceContentId:latest.id})}>已比较历史，基于服务端 v{latest.version} 保留我的编辑</button>}
    <div className={styles.actions}>
     {pending?<button onClick={()=>save('draft')} disabled={saveMutation.isPending}>恢复原保存</button>:<button onClick={()=>save('draft')} disabled={saveMutation.isPending}>保存稿件版本</button>}
     <button onClick={()=>setHistory(value=>!value)} aria-expanded={history}>历史版本</button>
    </div>
    {history&&<div className={styles.history} aria-label="稿件历史">{versions.length?versions.map(version=><article key={version.id}><strong>{version.title||item.title} · v{version.version} · {version.status==='final'?'已定稿':'草稿'}</strong><p>{version.contentAvailable===false?'来源已不可用':version.body}</p></article>):<p>还没有已保存版本。</p>}</div>}
   </>}
  </div>
  <footer><button className={styles.primary} onClick={()=>save('final')} disabled={pending||saveMutation.isPending||!item.sourceAvailable}>将标题和文章定稿</button><p>定稿不等于发布</p></footer>
 </div>;
}
