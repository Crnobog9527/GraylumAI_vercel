'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState,useEffect } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import styles from './library.module.css';

type ContentVersion={id:string;title?:string|null;kind:'brief'|'script'|'storyboard'|'editing';version:number;status:'draft'|'final';body:string|null;contentAvailable:boolean;sourceContentId:string|null;executionId:string|null;requestId:string;createdAt:string};
type Item={contentType?:string;workItemId:string;title:string;brief:string|null;day:string;revision:number;sessionId:string;sourceAvailable:boolean;content:ContentVersion[]};
type Account={projectId:string;platform:string;account:string;stage:'unknown'|'starting'|'growing'|'mature';revision:number;items:Item[]};
type Business={businessId:string;name:string;revision:number;sourceAvailable:boolean;accounts:Account[]};
const typeLabel:Record<string,string>={unknown:'类型待确认',article:'文章',image_text:'图文',video:'视频'};
const stageLabel={unknown:'阶段待确认',starting:'起步期',growing:'发展期',mature:'成熟期'} as const;

function ItemCard({item,account,onSaved,focused}:{item:Item;account:Account;onSaved:()=>Promise<unknown>;focused:boolean}){
 const [pendingSave,setPendingSave]=useState(false);
 useEffect(()=>{setPendingSave(Boolean(localStorage.getItem('opc-library-edit:'+item.workItemId)));},[item.workItemId]);
 const [contentType,setContentType]=useState(item.contentType??'unknown'),[editing,setEditing]=useState(false),[editRevision,setEditRevision]=useState<number|null>(null),[title,setTitle]=useState(item.title),[brief,setBrief]=useState(item.brief??''),[day,setDay]=useState(item.day),[error,setError]=useState('');
 const edit=trpc.opc.editLibrary.useMutation();
 function beginEdit(){setContentType(item.contentType??'unknown');setTitle(item.title);setBrief(item.brief??'');setDay(item.day);setEditRevision(item.revision);setError('');setEditing(true);}
 async function save(){if(editRevision===null&&!pendingSave)return;setError('');const key='opc-library-edit:'+item.workItemId;try{await navigator.locks.request(key,async()=>{const raw=localStorage.getItem(key);const frozen=raw?JSON.parse(raw):{requestId:crypto.randomUUID(),target:'item' as const,targetId:item.workItemId,expectedRevision:editRevision!,patch:{title:title.trim(),brief:brief.trim(),day,contentType}};localStorage.setItem(key,JSON.stringify(frozen));setPendingSave(true);await edit.mutateAsync(frozen);localStorage.removeItem(key);setPendingSave(false);setEditing(false);setEditRevision(null);await onSaved();});}catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){localStorage.setItem(key+':rejected',localStorage.getItem(key)??'');localStorage.removeItem(key);setPendingSave(false);setEditing(false);setEditRevision(null);await onSaved();setError('保存已明确拒绝，已读取当前版本，请重新编辑。');}else setError('保存结果待核实，请恢复原保存；完整原请求已保留。');}}

 useEffect(()=>{if(new URL(location.href).searchParams.get('item')===item.workItemId)document.getElementById('item-'+item.workItemId)?.scrollIntoView({block:'center'});},[item.workItemId]);
 return <article id={'item-'+item.workItemId} className={styles.item}>
  {pendingSave&&<Button disabled={edit.isPending} onClick={save}>恢复原保存</Button>}
  {editing?<div className="space-y-3"><label>内容类型<select aria-label="内容类型" disabled={pendingSave||edit.isPending} value={contentType} onChange={e=>setContentType(e.target.value)} className="ml-2 rounded border bg-[var(--bg-secondary)] p-2">{Object.entries(typeLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><input aria-label="选题标题" disabled={pendingSave||edit.isPending} value={title} maxLength={160} onChange={e=>setTitle(e.target.value)} className="w-full rounded border bg-[var(--bg-secondary)] p-2"/><Textarea aria-label="完整选题简报" disabled={pendingSave||edit.isPending} value={brief} maxLength={2000} onChange={e=>setBrief(e.target.value)}/><input aria-label="时间节点" disabled={pendingSave||edit.isPending} type="date" value={day} onChange={e=>setDay(e.target.value)} className="rounded border bg-[var(--bg-secondary)] p-2"/><div className="flex gap-2"><Button size="sm" disabled={pendingSave||edit.isPending||!title.trim()||!brief.trim()||!day} onClick={save}>保存修改</Button><Button size="sm" variant="ghost" disabled={pendingSave||edit.isPending} onClick={()=>{setEditing(false);setEditRevision(null);}}>取消</Button></div></div>:<>
   <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-[var(--text-tertiary)]">{typeLabel[item.contentType??'unknown']} · {item.day} · {account.platform}/{account.account}</p><h4 className="mt-1 font-medium">{item.title}</h4></div>{item.sourceAvailable&&<div className="flex gap-2"><Button size="sm" variant="outline" disabled={pendingSave} onClick={beginEdit}>直接编辑</Button><Link className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm text-[var(--bg-primary)]" href={'/runtime?session='+item.sessionId+'&continue=1'}>继续工作</Link></div>}</div>
   {item.sourceAvailable?<p className="mt-3 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{item.brief}</p>:<p className="mt-3 text-sm text-[var(--text-tertiary)]">来源已不可用，正文暂不可读。</p>}
   {item.content.length>0&&<details ref={node=>{if(node&&focused&&!node.dataset.initialized){node.open=true;node.dataset.initialized="true";}}} className="mt-3"><summary className="cursor-pointer text-sm">成果与历史 · {item.content.length} 个版本</summary><div className="mt-2 space-y-2">{item.content.map(content=><div key={content.id} className="rounded-lg bg-[var(--bg-secondary)] p-3 text-sm"><strong>{content.title?content.title+' · ':''}{content.kind==='script'?'口播稿':content.kind==='storyboard'?'分镜':content.kind==='editing'?'剪辑建议':(item.contentType==='article'?'文章正文':item.contentType==='image_text'?'图文草稿':'选题细化')} v{content.version} · {content.status==='final'?'已定稿':'草稿'}</strong><p className="mt-1 whitespace-pre-wrap">{content.contentAvailable?content.body:'该版本来源或历史已不可用，正文暂不可读。'}</p></div>)}</div></details>}
  </>}{error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </article>;
}

export default function LibraryPage(){
 const [search,setSearch]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[error,setError]=useState(''),[returnSession,setReturnSession]=useState(''),[focusedItemId,setFocusedItemId]=useState('');
 const [selectedProject,setSelectedProject]=useState('');
 useEffect(()=>{const url=new URL(location.href);setReturnSession(url.searchParams.get('return')??'');setFocusedItemId(url.searchParams.get('item')??'');},[]);
 const library=trpc.opc.library.useQuery({search,from:from||null,to:to||null});
 const edit=trpc.opc.editLibrary.useMutation();
 async function updateStage(account:Account,stage:Account['stage']){setError('');try{await edit.mutateAsync({requestId:crypto.randomUUID(),target:'account',targetId:account.projectId,expectedRevision:account.revision,patch:{stage}});await library.refetch();}catch{setError('账号阶段已有新版本。已停止覆盖，请刷新后重试。');}}
 const businesses=(library.data?.businesses??[]) as Business[];
 return <WorkspaceFrame area="library"><main className={styles.page}>
  <header className={styles.header}><div><h1>资料库</h1><p>按平台和账号查看已采用选题与已保存成果。</p></div>{returnSession?<Link aria-label="返回当前工作" href={"/runtime?session="+returnSession}>返回当前工作 →</Link>:<Link href="/positioning">返回工作区 →</Link>}</header>
  <div className={styles.catalog}>
   <nav className={styles.catalogNav} aria-label="资料库平台与账号"><button type="button" aria-current={!selectedProject?'page':undefined} onClick={()=>setSelectedProject('')}>全部账号 <span>{businesses.flatMap(b=>b.accounts).reduce((n,a)=>n+a.items.length,0)}</span></button>{[...new Set(businesses.flatMap(b=>b.accounts.map(a=>a.platform)))].map(platform=><div key={platform} className={styles.platform}><strong>{platform}</strong>{businesses.flatMap(b=>b.accounts).filter(a=>a.platform===platform).map(account=><button key={account.projectId} type="button" aria-current={selectedProject===account.projectId?'page':undefined} onClick={()=>setSelectedProject(account.projectId)}>{account.account}<span>{account.items.length}</span></button>)}</div>)}</nav>
   <div className={styles.catalogContent}>
    <div className={styles.filters}><label><Search size={17}/><input aria-label="查找资料" value={search} onChange={e=>setSearch(e.target.value)} placeholder="查找选题或稿件"/></label><label>开始 <input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>结束 <input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div>
    {library.isLoading&&<p role="status">正在读取资料库…</p>}{library.error&&<p role="alert">资料库当前不可用，或登录已失效。</p>}
    {businesses.map(business=>business.accounts.filter(account=>!selectedProject||account.projectId===selectedProject).map(account=><section key={account.projectId} className={styles.accountSection}><div className={styles.accountHead}><div><h2>{account.platform} · {account.account}</h2><p>{account.items.length} 条已采用选题 · {business.name} · 定位{business.sourceAvailable?'已确认':'待确认'}</p></div><select aria-label={'当前阶段 '+account.account} value={account.stage} onChange={e=>updateStage(account,e.target.value as Account['stage'])}>{Object.entries(stageLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div><div className={styles.items}>{account.items.length?account.items.map(item=><ItemCard key={item.workItemId} item={item} account={account} focused={focusedItemId===item.workItemId} onSaved={()=>library.refetch()}/>):<p className={styles.empty}>这个范围内还没有收录选题。</p>}</div></section>))}
    {!library.isLoading&&!businesses.length&&<p>资料库还是空的。先完成正式定位，再与 Agent 讨论并采用选题。</p>}{error&&<p role="alert">{error}</p>}
   </div>
  </div>
 </main></WorkspaceFrame>;
}
