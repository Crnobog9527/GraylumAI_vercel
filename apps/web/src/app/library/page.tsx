'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState,useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';

type ContentVersion={id:string;kind:'brief'|'script'|'storyboard'|'editing';version:number;status:'draft'|'final';body:string|null;contentAvailable:boolean;sourceContentId:string|null;executionId:string|null;requestId:string;createdAt:string};
type Item={contentType?:string;workItemId:string;title:string;brief:string|null;day:string;revision:number;sessionId:string;sourceAvailable:boolean;content:ContentVersion[]};
type Account={projectId:string;platform:string;account:string;stage:'unknown'|'starting'|'growing'|'mature';revision:number;items:Item[]};
type Business={businessId:string;name:string;revision:number;sourceAvailable:boolean;accounts:Account[]};
const typeLabel:Record<string,string>={unknown:'类型待确认',article:'文章',image_text:'图文',video:'视频'};
const stageLabel={unknown:'阶段待确认',starting:'起步期',growing:'发展期',mature:'成熟期'} as const;

function ItemCard({item,account,onSaved}:{item:Item;account:Account;onSaved:()=>Promise<unknown>}){
 const [pendingSave,setPendingSave]=useState(false);
 useEffect(()=>{setPendingSave(Boolean(localStorage.getItem('opc-library-edit:'+item.workItemId)));},[item.workItemId]);
 const [contentType,setContentType]=useState(item.contentType??'unknown'),[editing,setEditing]=useState(false),[editRevision,setEditRevision]=useState<number|null>(null),[title,setTitle]=useState(item.title),[brief,setBrief]=useState(item.brief??''),[day,setDay]=useState(item.day),[error,setError]=useState('');
 const edit=trpc.opc.editLibrary.useMutation();
 function beginEdit(){setContentType(item.contentType??'unknown');setTitle(item.title);setBrief(item.brief??'');setDay(item.day);setEditRevision(item.revision);setError('');setEditing(true);}
 async function save(){if(editRevision===null&&!pendingSave)return;setError('');const key='opc-library-edit:'+item.workItemId;try{await navigator.locks.request(key,async()=>{const raw=localStorage.getItem(key);const frozen=raw?JSON.parse(raw):{requestId:crypto.randomUUID(),target:'item' as const,targetId:item.workItemId,expectedRevision:editRevision!,patch:{title:title.trim(),brief:brief.trim(),day,contentType}};localStorage.setItem(key,JSON.stringify(frozen));setPendingSave(true);await edit.mutateAsync(frozen);localStorage.removeItem(key);setPendingSave(false);setEditing(false);setEditRevision(null);await onSaved();});}catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){localStorage.setItem(key+':rejected',localStorage.getItem(key)??'');localStorage.removeItem(key);setPendingSave(false);setEditing(false);setEditRevision(null);await onSaved();setError('保存已明确拒绝，已读取当前版本，请重新编辑。');}else setError('保存结果待核实，请恢复原保存；完整原请求已保留。');}}

 useEffect(()=>{if(new URL(location.href).searchParams.get('item')===item.workItemId)document.getElementById('item-'+item.workItemId)?.scrollIntoView({block:'center'});},[item.workItemId]);
 return <article id={'item-'+item.workItemId} className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
  {pendingSave&&<Button disabled={edit.isPending} onClick={save}>恢复原保存</Button>}
  {editing?<div className="space-y-3"><label>内容类型<select aria-label="内容类型" disabled={pendingSave||edit.isPending} value={contentType} onChange={e=>setContentType(e.target.value)} className="ml-2 rounded border bg-[var(--bg-secondary)] p-2">{Object.entries(typeLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><input aria-label="选题标题" disabled={pendingSave||edit.isPending} value={title} maxLength={160} onChange={e=>setTitle(e.target.value)} className="w-full rounded border bg-[var(--bg-secondary)] p-2"/><Textarea aria-label="完整选题简报" disabled={pendingSave||edit.isPending} value={brief} maxLength={2000} onChange={e=>setBrief(e.target.value)}/><input aria-label="时间节点" disabled={pendingSave||edit.isPending} type="date" value={day} onChange={e=>setDay(e.target.value)} className="rounded border bg-[var(--bg-secondary)] p-2"/><div className="flex gap-2"><Button size="sm" disabled={pendingSave||edit.isPending||!title.trim()||!brief.trim()||!day} onClick={save}>保存修改</Button><Button size="sm" variant="ghost" disabled={pendingSave||edit.isPending} onClick={()=>{setEditing(false);setEditRevision(null);}}>取消</Button></div></div>:<>
   <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-[var(--text-tertiary)]">{typeLabel[item.contentType??'unknown']} · {item.day} · {account.platform}/{account.account}</p><h4 className="mt-1 font-medium">{item.title}</h4></div>{item.sourceAvailable&&<div className="flex gap-2"><Button size="sm" variant="outline" disabled={pendingSave} onClick={beginEdit}>直接编辑</Button><Link className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm text-[var(--bg-primary)]" href={'/runtime?session='+item.sessionId+'&continue=1'}>继续工作</Link></div>}</div>
   {item.sourceAvailable?<p className="mt-3 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{item.brief}</p>:<p className="mt-3 text-sm text-[var(--text-tertiary)]">来源已不可用，正文暂不可读。</p>}
   {item.content.length>0&&<details className="mt-3"><summary className="cursor-pointer text-sm">成果与历史 · {item.content.length} 个版本</summary><div className="mt-2 space-y-2">{item.content.map(content=><div key={content.id} className="rounded-lg bg-[var(--bg-secondary)] p-3 text-sm"><strong>{content.kind==='script'?'口播稿':content.kind==='storyboard'?'分镜':content.kind==='editing'?'剪辑建议':(item.contentType==='article'?'文章正文':item.contentType==='image_text'?'图文草稿':'选题细化')} v{content.version} · {content.status==='final'?'已定稿':'草稿'}</strong><p className="mt-1 whitespace-pre-wrap">{content.contentAvailable?content.body:'该版本来源或历史已不可用，正文暂不可读。'}</p></div>)}</div></details>}
  </>}{error&&<p role="alert" className="mt-2 text-sm">{error}</p>}
 </article>;
}

export default function LibraryPage(){
 const [search,setSearch]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[error,setError]=useState('');
 const library=trpc.opc.library.useQuery({search,from:from||null,to:to||null});
 const edit=trpc.opc.editLibrary.useMutation();
 async function updateStage(account:Account,stage:Account['stage']){setError('');try{await edit.mutateAsync({requestId:crypto.randomUUID(),target:'account',targetId:account.projectId,expectedRevision:account.revision,patch:{stage}});await library.refetch();}catch{setError('账号阶段已有新版本。已停止覆盖，请刷新后重试。');}}
 const businesses=(library.data?.businesses??[]) as Business[];
 return <main className="mx-auto max-w-6xl space-y-6 p-4 text-[var(--text-primary)] sm:p-6">
  <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><Link href="/positioning" aria-label="返回定位"><ArrowLeft className="h-5 w-5"/></Link><div><h1 className="text-2xl font-semibold">内容资料库</h1><p className="text-sm text-[var(--text-secondary)]">按业务、平台账号与时间整理。周计划是时间范围，不会为每一周另建一套页面。</p></div></div><Link className="underline" href="/positioning">定位与新业务</Link></header>
  <section className="grid gap-3 rounded-xl border border-[var(--border-primary)] p-4 sm:grid-cols-[1fr_auto_auto]"><label className="flex items-center gap-2"><Search className="h-4 w-4"/><input aria-label="查找资料" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索标题或简报" className="w-full rounded border bg-[var(--bg-secondary)] p-2"/></label><label>开始 <input type="date" value={from} onChange={e=>setFrom(e.target.value)} className="rounded border bg-[var(--bg-secondary)] p-2"/></label><label>结束 <input type="date" value={to} onChange={e=>setTo(e.target.value)} className="rounded border bg-[var(--bg-secondary)] p-2"/></label></section>
  {library.isLoading&&<p role="status">正在读取资料库…</p>}{library.error&&<p role="alert">资料库当前不可用，或登录已失效。</p>}
  {businesses.map(business=><section key={business.businessId} className="space-y-4 rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5"><div><h2 className="text-xl font-semibold">{business.name}</h2><p className="text-sm text-[var(--text-tertiary)]">核心定位：{business.sourceAvailable?'正式版本可用':'尚未完成或来源不可用'}</p></div>{business.accounts.map(account=><section key={account.projectId} className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{account.platform} · {account.account}</h3><select aria-label={'当前阶段 '+account.account} value={account.stage} onChange={e=>updateStage(account,e.target.value as Account['stage'])} className="rounded border bg-[var(--bg-primary)] p-2 text-sm">{Object.entries(stageLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>{account.items.length?account.items.map(item=><ItemCard key={item.workItemId} item={item} account={account} onSaved={()=>library.refetch()}/>):<p className="text-sm text-[var(--text-tertiary)]">这个时间范围内暂无选题。</p>}</section>)}</section>)}
  {!library.isLoading&&!businesses.length&&<p>资料库还是空的。先完成正式定位，再与 Agent 讨论并采用选题。</p>}{error&&<p role="alert">{error}</p>}
 </main>;
}
