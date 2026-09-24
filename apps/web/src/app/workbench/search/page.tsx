'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { trpc } from '@/trpc/client';
import styles from './workspace-search.module.css';

type Work = { workItemId:string;sessionId:string;title:string;chatName?:string;brief:string|null;archived?:boolean;deleted?:boolean;uiRevision?:number };
type Account = { projectId:string;platform:string;account:string;displayName?:string;strategyDraftId?:string|null;items:Work[] };
type Business = { accounts:Account[] };
type Draft = { draftId:string;businessName?:string;state?:string };

export default function WorkspaceSearch(){
 const [query,setQuery]=useState(''),[returnTo,setReturnTo]=useState(''),[restoring,setRestoring]=useState(''),[error,setError]=useState('');
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null});
 const drafts=trpc.opc.list.useQuery();
 const modules=trpc.modules.getModules.useQuery({limit:100,offset:0,sortBy:'newest'});
 const changeWorkUi=trpc.opc.workUiChange.useMutation();
 useEffect(()=>{const params=new URL(location.href).searchParams;setReturnTo(params.get('returnTo')??sessionStorage.getItem('opc-work-return')??'');},[]);
 const back=/^\/(runtime\?session=[0-9a-f-]{36}|positioning\/[0-9a-f-]{36}(\/topics)?)([&#?].*)?$/i.test(returnTo)?returnTo:'/positioning';
 const normalized=query.trim().toLocaleLowerCase();
 const matches=(...values:(string|undefined|null)[])=>!normalized||values.some(value=>value?.toLocaleLowerCase().includes(normalized));
 const accounts=((library.data?.businesses??[]) as Business[]).flatMap(business=>business.accounts);
 const works=accounts.flatMap(account=>account.items.filter(item=>!item.deleted&&matches(item.chatName??item.title,item.brief,account.platform,account.account,account.displayName)).map(item=>({account,item})))
  .sort((a,b)=>Number(Boolean(a.item.archived))-Number(Boolean(b.item.archived)));
 const assigned=new Set(accounts.map(account=>account.strategyDraftId).filter(Boolean));
 const strategies=accounts.filter(account=>account.strategyDraftId&&matches('定位策略',account.platform,account.account,account.displayName));
 const unassigned=((drafts.data?.drafts??[]) as Draft[]).filter(draft=>!assigned.has(draft.draftId)&&matches(draft.businessName,'定位分析'));
 const skills=(modules.data?.modules??[]).filter(module=>matches(module.title,module.description));
 async function restore(item:Work){
  if(changeWorkUi.isPending)return;
  const key='opc-work-ui:'+item.workItemId,raw=sessionStorage.getItem(key);
  const frozen=raw?JSON.parse(raw) as {workItemId:string;requestId:string;expectedRevision:number;action:'restore'}:{workItemId:item.workItemId,requestId:crypto.randomUUID(),expectedRevision:item.uiRevision??1,action:'restore' as const};
  if(raw&&frozen.action!=='restore'){setError('上次操作的结果待核实，请先回到工作列表恢复原操作。');return;}
  sessionStorage.setItem(key,JSON.stringify(frozen));setRestoring(item.workItemId);setError('');
  try{await changeWorkUi.mutateAsync(frozen);sessionStorage.removeItem(key);await library.refetch();}
  catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){sessionStorage.removeItem(key);await library.refetch();setError('恢复未保存（'+code+'）。列表已刷新，请核对后重试。');}else setError('恢复结果暂不确定；原请求已保留，请用同一操作核对，避免重复写入。');}
  finally{setRestoring('');}
 }
 return <WorkspaceFrame area="search"><main className={styles.page}>
  <header className={styles.heading}><h1>搜索</h1><Link href={back}>返回原工作 →</Link></header>
  <p className={styles.intro}>查找工作、归档记录和功能。打开具体工作才会切换对话；恢复归档不会自动打开。</p>
  <label className={styles.search} htmlFor="workspace-search">搜索工作或功能</label>
  <input id="workspace-search" className={styles.searchInput} type="search" autoFocus placeholder="输入标题、平台或账号" value={query} onChange={event=>setQuery(event.target.value)}/>
  {error&&<p role="alert" className={styles.error}>{error}</p>}
  <div className={styles.results}>
   <section aria-label="工作记录"><h2>工作记录</h2>
    {strategies.map(account=><Link className={styles.row} href={'/positioning/'+account.strategyDraftId} key={'strategy-'+account.projectId}><strong>定位策略</strong><small>{account.platform} · {account.displayName??account.account}</small></Link>)}
    {works.map(({account,item})=><div className={styles.workRow} key={item.workItemId}><Link className={styles.row} href={'/runtime?session='+encodeURIComponent(item.sessionId)}><strong>{item.chatName??item.title}</strong><small>{account.platform} · {account.displayName??account.account}{item.archived?' · 已归档':''}</small></Link>{item.archived&&<button type="button" disabled={Boolean(restoring)} onClick={()=>void restore(item)}>{restoring===item.workItemId?'恢复中…':'恢复'}</button>}</div>)}
    {unassigned.map(draft=><Link className={styles.row} href={'/positioning/'+draft.draftId} key={draft.draftId}><strong>{draft.businessName??'新账号'} · 定位分析</strong><small>{draft.state==='published'?'已确认':'进行中'}</small></Link>)}
    {!library.isLoading&&!drafts.isLoading&&!strategies.length&&!works.length&&!unassigned.length&&<p className={styles.empty}>没有匹配的工作。</p>}
   </section>
   <section aria-label="功能"><h2>功能</h2>{modules.isLoading&&<p className={styles.empty}>正在读取功能…</p>}{modules.error&&<p role="alert">功能目录暂不可用。</p>}{skills.map(module=><Link className={styles.row} href={'/workbench/marketplace?module='+encodeURIComponent(module.id)+'&returnTo='+encodeURIComponent(back)} key={module.id}><strong>{module.title}</strong><small>{module.description}</small></Link>)}{!modules.isLoading&&!skills.length&&<p className={styles.empty}>没有匹配的功能。</p>}{modules.data?.hasMore&&<Link className={styles.more} href={'/workbench/marketplace?returnTo='+encodeURIComponent(back)}>在功能广场浏览更多 →</Link>}</section>
  </div>
 </main></WorkspaceFrame>;
}
