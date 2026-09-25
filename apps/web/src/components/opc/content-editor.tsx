'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type ReactNode } from 'react';
import { trpc } from '@/trpc/client';
import { VersionCompare } from './version-compare';
import styles from './content-editor.module.css';

export type ContentVersion={id:string;kind:string;version:number;status:string;title?:string|null;body:string|null;contentAvailable?:boolean;sourceContentId:string|null;executionId:string|null;requestId:string};
export type EditableItem={workItemId:string;sessionId:string;title:string;brief:string|null;contentType?:string;platform:string;account:string;sourceAvailable:boolean;content:ContentVersion[]};
type Draft={baseVersion:number;sourceContentId:string|null;title:string;body:string};
type Frozen=Draft&{workItemId:string;requestId:string;expectedVersion:number;kind:'brief'|'script';status:'draft'|'final'};
export type ContentEditorHandle={finalize:()=>void};
const rejected=new Set(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_CONTENT_DENIED','OPC_CONTENT_INVALID','OPC_CONTENT_SOURCE','OPC_CONTENT_BINDING']);

export const ContentEditor=forwardRef<ContentEditorHandle,{item:EditableItem;onSaved:()=>Promise<unknown>;children?:ReactNode}>(function ContentEditor({item,onSaved,children},ref){
 const kind=item.contentType==='video'?'script':'brief';
 const versions=useMemo(()=>item.content.filter(version=>version.kind===kind).sort((a,b)=>b.version-a.version),[item.content,kind]);
 const latest=versions[0]??null;
 const key='opc-content-draft:'+item.workItemId+':'+kind;
 const pendingKey='opc-content-save:'+item.workItemId+':'+kind;
 const [draft,setDraft]=useState<Draft|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const [history,setHistory]=useState(false),[expanded,setExpanded]=useState(false);
 useEffect(()=>{if(!expanded)return;function onEscape(event:KeyboardEvent){if(event.key==='Escape')setExpanded(false);}window.addEventListener('keydown',onEscape);return()=>window.removeEventListener('keydown',onEscape);},[expanded]);
 const [expandedTitle,setExpandedTitle]=useState(''),[expandedBody,setExpandedBody]=useState('');
 const saveMutation=trpc.opc.saveContentManual.useMutation();
 useEffect(()=>{
  try{
   const legacyDraft='opc-content-draft:'+item.workItemId;
   const legacyPending='opc-content-save:'+item.workItemId;
   const oldPending=localStorage.getItem(legacyPending);
   const pendingKind=oldPending?(JSON.parse(oldPending) as Frozen).kind:null;
   const oldDraft=localStorage.getItem(legacyDraft);
   if(oldDraft){
    const old=JSON.parse(oldDraft) as Draft;
    const sourceKind=item.content.find(version=>version.id===old.sourceContentId)?.kind;
    const knownKinds=[...new Set(item.content.filter(version=>version.kind==='brief'||version.kind==='script').map(version=>version.kind))];
    const oldKind=pendingKind??sourceKind??(knownKinds.length===1?knownKinds[0]:knownKinds.length===0?kind:null);
    if(oldKind==='brief'||oldKind==='script'){
     const scopedDraft='opc-content-draft:'+item.workItemId+':'+oldKind;
     if(!localStorage.getItem(scopedDraft))localStorage.setItem(scopedDraft,oldDraft);
     else localStorage.setItem(legacyDraft+':backup',oldDraft);
     localStorage.removeItem(legacyDraft);
    }else setError('检测到旧版未归类编辑；原输入仍保留在本机，请先核对稿件类型。');
   }
   if(oldPending){
    const scopedPending='opc-content-save:'+item.workItemId+':'+pendingKind;
    if(!localStorage.getItem(scopedPending))localStorage.setItem(scopedPending,oldPending);
    localStorage.removeItem(legacyPending);
   }
   const cached=localStorage.getItem(key);
   setDraft(cached?JSON.parse(cached) as Draft:{baseVersion:latest?.version??0,sourceContentId:latest?.id??null,title:latest?.title||item.title,body:latest?.body??''});
   setPending(Boolean(localStorage.getItem(pendingKey)));
  }catch{setError('本机未保存的编辑无法读取，请先保留当前页面内容。');}
 // A new server version must never replace local unsaved input.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[item.workItemId,kind]);
 useEffect(()=>{
  if(!latest||localStorage.getItem(key))return;
  setDraft(current=>current&&current.baseVersion<latest.version?{baseVersion:latest.version,sourceContentId:latest.id,title:latest.title||item.title,body:latest.body??''}:current);
 },[latest?.id,item.title,key]);
 function openExpanded(){if(!draft)return;setExpandedTitle(draft.title);setExpandedBody(draft.body);setExpanded(true);}
 function change(patch:Partial<Draft>){
  if(!draft)return;
  const next={...draft,...patch};
  try{localStorage.setItem(key,JSON.stringify(next));setDraft(next);setSaved('正在自动同步草稿…');}
  catch{setError('无法保留未保存编辑，请检查本机存储。');}
 }
 useEffect(()=>{
  if(!draft||!item.sourceAvailable||!draft.title.trim()||!draft.body.trim()||pending||error||!localStorage.getItem(key)||localStorage.getItem(pendingKey))return;
  const timer=window.setTimeout(()=>{void save('draft');},1500);
  return()=>window.clearTimeout(timer);
 // Save a settled edit, never every keystroke. The existing idempotent save handles recovery.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[draft,pending,error,key,pendingKey,item.sourceAvailable]);
 async function save(status:'draft'|'final',offeredBody?:string){
  if(!draft||!item.sourceAvailable||latest&&latest.contentAvailable===false)return;
  const pendingRaw=localStorage.getItem(pendingKey);
  const body=(offeredBody??draft.body).trim(),title=draft.title.trim();
  if(!pendingRaw&&(!title||!body)){setError('请填写标题和正文。');return;}
  if(!pendingRaw&&(body.length>20000||title.length>160)){setError('标题或正文超出长度限制。');return;}
  // A successful save can advance the draft before the library query refreshes.
  // The service checks expectedVersion, so a stale query must not block the next explicit save.
  if(!pendingRaw&&latest?.version===draft.baseVersion&&latest?.status===status&&latest?.title===title&&latest?.body===body){
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
 useImperativeHandle(ref,()=>({finalize:()=>{void save('final');}}));
 if(!draft)return <p className={styles.loading}>正在读取当前成果…</p>;
 return <div className={styles.editor}>
  <header><p className={styles.label}>正文稿件</p><p className={styles.meta}>{item.platform} · {item.account} · {item.contentType==='video'?'口播稿':'文章'}</p></header>
  <div className={styles.body}>
   {!item.sourceAvailable||latest&&latest.contentAvailable===false?<p role="alert">来源已不可用，不能编辑或保存这条工作。</p>:<>
    <label>稿件标题<input aria-label="稿件标题" value={draft.title} onChange={event=>change({title:event.target.value})} maxLength={160}/></label>
    <label>{kind==='script'?'口播稿正文':'文章正文'}<textarea aria-label={kind==='script'?'口播稿正文':'文章正文'} value={draft.body} onChange={event=>change({body:event.target.value})} maxLength={20000} placeholder="先写下草稿，保存后会形成可找回的版本。"/></label>
    <p className={styles.version}>{latest?'账号已保存 v'+latest.version+' · '+(latest.status==='final'?'已定稿':'草稿'):'草稿会在停止输入后自动同步到账号'}</p>
    {saved&&<p role="status" className={styles.success}>{saved}</p>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {latest&&draft.baseVersion<latest.version&&!pending&&<button className={styles.rebase} onClick={()=>change({baseVersion:latest.version,sourceContentId:latest.id})}>已比较历史，基于服务端 v{latest.version} 保留我的编辑</button>}
    <div className={styles.actions}>
     {pending&&<button onClick={()=>save('draft')} disabled={saveMutation.isPending}>恢复草稿同步</button>}
     <button onClick={openExpanded}>展开编辑</button>
     <button onClick={()=>setHistory(true)}>历史版本</button>
    </div>
    {children}
   </>}
  </div>
  <footer><button className={styles.primary} onClick={()=>save('final')} disabled={pending||saveMutation.isPending||!item.sourceAvailable}>确认定稿{kind==='script'?'口播稿':'文章'}</button><p>修改会自动同步为草稿；定稿会另存正式版本，不等于发布。</p></footer>
  {expanded&&<div className={styles.backdrop} onMouseDown={event=>{if(event.target===event.currentTarget)setExpanded(false);}}><div role="dialog" aria-modal="true" aria-label="编辑标题与正文" className={styles.modal}><header><h2>编辑标题与正文</h2><button aria-label="关闭编辑" onClick={()=>setExpanded(false)}>×</button></header><div className={styles.modalFields}><label>稿件标题<input aria-label="展开编辑标题" value={expandedTitle} maxLength={160} onChange={event=>setExpandedTitle(event.target.value)}/></label><label>{kind==='script'?'口播稿正文':'文章正文'}<textarea aria-label="展开编辑正文" value={expandedBody} maxLength={20000} onChange={event=>setExpandedBody(event.target.value)}/></label></div><footer><p>确认修改后会自动同步为草稿。</p><div><button onClick={()=>setExpanded(false)}>取消</button><button className={styles.primary} onClick={()=>{change({title:expandedTitle,body:expandedBody});setExpanded(false);}}>确认修改</button></div></footer></div></div>}
  {history&&<VersionCompare versions={versions} onClose={()=>setHistory(false)}/>}
 </div>;
});
