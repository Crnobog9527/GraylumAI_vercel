'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/trpc/client';
import styles from './strategy-overview-dialog.module.css';

type ProfileValue={label?:string;value?:string;status?:string};
type Account={projectId:string;platform:string;account:string;strategyDraftId:string;sourceVersionId:string;pendingStrategyDraftId?:string|null;currentVersion?:number;profile?:Record<string,ProfileValue>|null};
type Value={value:string;status:'unknown'|'unclear'|'provisional'|'confirmed'|'deferred';nature:'fact'|'decision'|'hypothesis'|'unknown'};
type Edits=Record<string,Record<string,string>>;
type Frozen={accountProjectId:string;requestId:string;expectedSourceVersionId:string;expectedPendingDraftId:string|null;edits:Edits};

export function StrategyOverviewDialog({account,onClose,onSaved}:{account:Account;onClose:()=>void;onSaved:()=>Promise<unknown>}){
 const draftId=account.pendingStrategyDraftId??account.strategyDraftId;
 const read=trpc.opc.read.useQuery({draftId});
 const [history,setHistory]=useState(false),[historyVersion,setHistoryVersion]=useState<string|null>(null);
 const positionHistory=trpc.opc.accountStrategyHistory.useQuery({accountProjectId:account.projectId},{enabled:history});
 const saveStrategy=trpc.opc.accountStrategySave.useMutation();
 const [editing,setEditing]=useState(false),[edits,setEdits]=useState<Edits>({}),[saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(''),[recoverable,setRecoverable]=useState(false),[savedDraftId,setSavedDraftId]=useState<string|null>(null);
 const key='opc-library-strategy-save:'+account.projectId;
 useEffect(()=>{setRecoverable(Boolean(sessionStorage.getItem(key)));},[key]);
 useEffect(()=>{function escape(event:KeyboardEvent){if(event.key==='Escape'&&!saving)onClose();}window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[onClose,saving]);
 const data=read.data;
 const entries=data?Object.entries(data.information as Record<string,{schema:Array<{id:string;title:string;profileKey?:string}>;values:Record<string,Value>|null}>):[];
 function baseValue(entry:{values:Record<string,Value>|null},field:{id:string;profileKey?:string}){
  return account.pendingStrategyDraftId?entry.values?.[field.id]?.value??'':field.profileKey?account.profile?.[field.profileKey]?.value??entry.values?.[field.id]?.value??'':entry.values?.[field.id]?.value??'';
 }
 const changed=entries.some(([stepId,entry])=>entry.schema.some(field=>Object.hasOwn(edits[stepId]??{},field.id)&&edits[stepId][field.id]!==baseValue(entry,field)));
 function beginEdit(){const next:Edits={};for(const [stepId,entry] of entries){next[stepId]={};for(const field of entry.schema)next[stepId][field.id]=baseValue(entry,field);}setEdits(next);setError('');setSaved('');setEditing(true);}
 async function save(){
  if(!data||saving||!account.sourceVersionId)return;
  setError('');setSaved('');setSaving(true);
  try{await navigator.locks.request(key,async()=>{
   let frozen:Frozen;
   const raw=sessionStorage.getItem(key);
   if(raw)frozen=JSON.parse(raw) as Frozen;
   else{
    const changes:Edits={};
    for(const [stepId,entry] of entries)for(const field of entry.schema){const next=edits[stepId]?.[field.id];if(next!==undefined&&next!==baseValue(entry,field)){changes[stepId]??={};changes[stepId][field.id]=next;}}
    if(!Object.keys(changes).length)return;
    frozen={accountProjectId:account.projectId,requestId:crypto.randomUUID(),expectedSourceVersionId:account.sourceVersionId,expectedPendingDraftId:account.pendingStrategyDraftId??null,edits:changes};
    sessionStorage.setItem(key,JSON.stringify(frozen));setRecoverable(true);
   }
   const result=await saveStrategy.mutateAsync(frozen);
   sessionStorage.removeItem(key);setRecoverable(false);
   setSavedDraftId(result.draftId);
   await onSaved();
   setEditing(false);setSaved('已保存到此账号的待确认定位草稿。原正式版本及已有选题、稿件来源保持不变；请逐项确认后再发布新版。');
  });}
  catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_INFORMATION_CONFLICT','OPC_INFORMATION_INVALID','OPC_DENIED','OPC_REQUEST_CONFLICT','OPC_SOURCE_DENIED'].includes(code)){sessionStorage.removeItem(key);setRecoverable(false);await onSaved();setError('服务端拒绝保存（'+code+'）。输入仍保留，请核对账号的当前版本。');}else setError('保存结果暂不确定。原请求已保留；再次保存只会恢复同一请求。');}
  finally{setSaving(false);}
 }
 return <div className={styles.backdrop} onMouseDown={event=>{if(event.target===event.currentTarget&&!saving)onClose();}}><section role="dialog" aria-modal="true" aria-label="定位详情" className={editing?`${styles.dialog} ${styles.editDialog}`:styles.dialog}>
  <header><h2>{editing?'修改定位':'定位详情'}</h2><button type="button" aria-label="关闭定位详情" disabled={saving} onClick={onClose}>×</button></header>
  <div className={styles.body}>{read.isLoading?<p>正在读取定位…</p>:read.error?<p role="alert">当前账号的定位无法读取。请确认登录状态后重试。</p>:<>
   <div className={styles.meta}><span>{account.platform}</span><span>{account.account}</span><span>{account.currentVersion?`当前 v${account.currentVersion}`:'策略待确认'}</span>{account.pendingStrategyDraftId?<span>此账号有待确认修订</span>:null}</div>
   {(editing||recoverable)&&<p className={styles.notice}>{recoverable?'上一次保存结果待核实。请先恢复原请求，再继续编辑。':'仅修改当前账号的定位草稿；取消不写入，正式版本须按原流程逐项确认。'}</p>}
   {history?<div className={styles.history}><nav aria-label="定位版本">{((positionHistory.data??[]) as Array<{id:string;version:number;source:string;profile:Record<string,ProfileValue>}>).map(version=><button type="button" key={version.id} aria-current={(historyVersion??positionHistory.data?.[0]?.id)===version.id?'page':undefined} onClick={()=>setHistoryVersion(version.id)}>v{version.version} · {version.source==='account'?'账号修订':'共享来源'}</button>)}</nav><div className={styles.historyValues}>{positionHistory.isLoading?'正在读取实际历史版本…':positionHistory.error?<p role="alert">历史版本暂不可读。</p>:((positionHistory.data??[]) as Array<{id:string;version:number;profile:Record<string,ProfileValue>}>).length===0?<p>暂无正式历史版本。</p>:Object.entries(((positionHistory.data??[]) as Array<{id:string;version:number;profile:Record<string,ProfileValue>}>).find(version=>version.id===(historyVersion??positionHistory.data?.[0]?.id))?.profile??{}).map(([key,field])=><div key={key}><strong>{field.label??key}</strong><p>{field.value||'待补充'}</p></div>)}</div></div>:<div className={styles.sections}>{entries.map(([stepId,entry],index)=><details key={stepId} open={index===0||editing}><summary><span><strong>{data?.snapshot.workflow.steps.find((step:{id:string;title:string})=>step.id===stepId)?.title??'定位步骤'}</strong><small>{entry.schema.map(field=>field.title).join(' · ')}</small></span><span className={styles.chevron}>＋</span></summary><div className={styles.fields}>{entry.schema.map(field=><label key={field.id}><span>{field.title}</span>{editing?<textarea maxLength={400} value={edits[stepId]?.[field.id]??''} disabled={saving||recoverable} onChange={event=>setEdits(current=>({...current,[stepId]:{...current[stepId],[field.id]:event.target.value}}))}/>:<p>{baseValue(entry,field)||'待补充'}</p>}<small>{editing?'待确认修订':account.pendingStrategyDraftId?'待确认草稿':account.currentVersion?`正式 v${account.currentVersion}`:'待确认'}</small></label>)}</div></details>)}</div>}
  </>}{error&&<p role="alert" className={styles.error}>{error}</p>}{saved&&<p role="status" className={styles.success}>{saved} {savedDraftId&&<Link href={'/positioning/'+savedDraftId}>继续确认定位 →</Link>}</p>}</div>
  <footer>{history?<button type="button" onClick={()=>setHistory(false)}>返回当前定位</button>:editing?<><button type="button" disabled={saving} onClick={()=>{setEditing(false);setError('');}}>取消</button><button type="button" className={styles.primary} disabled={saving||(!changed&&!recoverable)} onClick={save}>{saving?'保存中…':recoverable?'恢复原保存':'确认保存'}</button></>:<><button type="button" onClick={beginEdit}>修改定位</button><button type="button" onClick={()=>setHistory(true)}>历史版本</button><Link className={styles.primary} href={'/positioning/'+(savedDraftId??draftId)}>回到策略讨论</Link></>}</footer>
 </section></div>;
}
