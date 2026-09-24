'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { ContentEditor } from '@/components/opc/content-editor';
import { VersionCompare } from '@/components/opc/version-compare';
import styles from './library.module.css';

type ContentVersion={id:string;title?:string|null;kind:'brief'|'script'|'storyboard'|'editing';version:number;status:'draft'|'final';body:string|null;contentAvailable:boolean;sourceContentId:string|null;executionId:string|null;requestId:string;createdAt:string};
type Item={contentType?:string;workItemId:string;title:string;brief:string|null;day:string;revision:number;sessionId:string;sourceAvailable:boolean;content:ContentVersion[]};
type Account={projectId:string;platform:string;account:string;stage:'unknown'|'starting'|'growing'|'mature';revision:number;items:Item[]};
type Business={businessId:string;name:string;revision:number;sourceAvailable:boolean;accounts:Account[]};
type ViewState={search:string;from:string;to:string;selectedProject:string;scrollTop:number};
const typeLabel:Record<string,string>={unknown:'类型待确认',article:'文章',image_text:'图文',video:'视频'};
const stageLabel={unknown:'阶段待确认',starting:'起步期',growing:'发展期',mature:'成熟期'} as const;
const definite=new Set(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID','OPC_CONTENT_DENIED','OPC_CONTENT_INVALID','OPC_CONTENT_SOURCE']);

function ItemCard({item,account,onSaved,focused}:{item:Item;account:Account;onSaved:()=>Promise<unknown>;focused:boolean}){
 const [open,setOpen]=useState(false),[mode,setMode]=useState<'overview'|'metadata'|'content'>('overview'),[history,setHistory]=useState(false);
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 const [contentType,setContentType]=useState(item.contentType??'unknown'),[revision,setRevision]=useState(item.revision),[title,setTitle]=useState(item.title),[brief,setBrief]=useState(item.brief??''),[day,setDay]=useState(item.day);
 const edit=trpc.opc.editLibrary.useMutation(),finalize=trpc.opc.saveContentManual.useMutation();
 const kind=item.contentType==='video'?'script':'brief';
 const versions=item.content.filter(version=>version.kind===kind).sort((a,b)=>b.version-a.version),latest=versions[0];
 const editKey='opc-library-edit:'+item.workItemId,finalKey='opc-library-final:'+item.workItemId;
 useEffect(()=>{setPending(Boolean(localStorage.getItem(editKey)||localStorage.getItem(finalKey)));},[editKey,finalKey]);
 useEffect(()=>{if(focused){document.getElementById('item-'+item.workItemId)?.scrollIntoView({block:'center'});setOpen(true);}},[focused,item.workItemId]);
 useEffect(()=>{if(!open)return;function escape(event:KeyboardEvent){if(event.key==='Escape'&&!pending){setOpen(false);setMode('overview');}}window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[open,pending]);
 function beginMetadata(){setContentType(item.contentType??'unknown');setRevision(item.revision);setTitle(item.title);setBrief(item.brief??'');setDay(item.day);setError('');setMode('metadata');}
 async function saveMetadata(){setError('');try{await navigator.locks.request(editKey,async()=>{const raw=localStorage.getItem(editKey);const frozen=raw?JSON.parse(raw):{requestId:crypto.randomUUID(),target:'item' as const,targetId:item.workItemId,expectedRevision:revision,patch:{title:title.trim(),brief:brief.trim(),day,contentType}};localStorage.setItem(editKey,JSON.stringify(frozen));setPending(true);await edit.mutateAsync(frozen);localStorage.removeItem(editKey);setPending(false);await onSaved();setMode('overview');});}catch(cause){const code=cause instanceof Error?cause.message:'';if(definite.has(code)){localStorage.removeItem(editKey);setPending(false);await onSaved();setError('保存被拒绝（'+code+'）。编辑内容仍保留，请核对最新版本。');}else setError('保存结果待核实。原请求已保留；请恢复原保存。');}}
 async function finalizeLatest(){if(!latest||!item.sourceAvailable||item.contentType==='video')return;if(localStorage.getItem('opc-content-draft:'+item.workItemId)){setError('有未保存编辑。请先进入稿件编辑，确认内容后再定稿。');return;}setError('');try{await navigator.locks.request(finalKey,async()=>{const raw=localStorage.getItem(finalKey);const frozen=raw?JSON.parse(raw):{workItemId:item.workItemId,requestId:crypto.randomUUID(),expectedVersion:latest.version,sourceContentId:latest.id,kind:'brief' as const,status:'final' as const,title:latest.title||item.title,body:latest.body??''};localStorage.setItem(finalKey,JSON.stringify(frozen));setPending(true);await finalize.mutateAsync(frozen);localStorage.removeItem(finalKey);setPending(false);await onSaved();});}catch(cause){const code=cause instanceof Error?cause.message:'';if(definite.has(code)){localStorage.removeItem(finalKey);setPending(false);await onSaved();setError('定稿被拒绝（'+code+'）。当前内容保留，请比较后再操作。');}else setError('定稿结果待核实。原请求已保留；再次点击只恢复原请求。');}}
 return <article id={'item-'+item.workItemId} className={styles.item}>
  <button className={styles.itemOpen} onClick={()=>{setOpen(true);setMode('overview');}}><span><strong>{item.title}</strong><small>{account.platform} · {account.account} · {typeLabel[item.contentType??'unknown']} · {latest?`v${latest.version} ${latest.status==='final'?'已定稿':'草稿'}`:'待起草'}</small></span><span>查看详情 →</span></button>
  {open&&<div className={styles.backdrop} onMouseDown={event=>{if(event.target===event.currentTarget&&!pending)setOpen(false);}}><div role="dialog" aria-modal="true" aria-label="选题详情" className={styles.dialog}>
   <header className={styles.dialogHead}><div><h2>选题详情</h2><h3>{item.title}</h3><p>{account.platform} · {account.account} · {typeLabel[item.contentType??'unknown']} · {latest?`v${latest.version} ${latest.status==='final'?'已定稿':'草稿'}`:'待起草'}</p></div><button aria-label="关闭窗口" disabled={pending} onClick={()=>setOpen(false)}>×</button></header>
   {mode==='overview'&&<div className={styles.dialogBody}><section><h4>稿件</h4><p className={styles.muted}>{latest?`已保存 v${latest.version} · ${latest.status==='final'?'已定稿':'草稿'}`:'尚未保存稿件'}</p><p className={styles.preview}>{latest?(latest.contentAvailable?latest.body:'该版本来源已不可用，正文暂不展示。'):item.brief}</p><div className={styles.actionRow}><button disabled={!item.sourceAvailable||item.contentType==='video'} onClick={()=>setMode('content')}>编辑稿件</button><button onClick={()=>setHistory(true)}>稿件历史</button><Link href={'/runtime?session='+item.sessionId}>继续讨论</Link><button disabled={!latest||!item.sourceAvailable||latest.status==='final'||item.contentType==='video'||finalize.isPending} onClick={finalizeLatest}>{pending?'恢复原定稿':'将当前稿件定稿'}</button></div><button className={styles.textAction} onClick={beginMetadata}>编辑选题信息</button></section><section><h4>发布安排</h4><p className={styles.muted}>发布排期 · 待接入。定稿不等于发布。</p></section>{error&&<p role="alert" className={styles.error}>{error}</p>}</div>}
   {mode==='metadata'&&<div className={styles.dialogBody}><section className={styles.metaForm}><h4>编辑选题信息</h4><label>内容类型<select aria-label="内容类型" disabled={pending||edit.isPending} value={contentType} onChange={event=>setContentType(event.target.value)}>{Object.entries(typeLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>选题标题<input aria-label="选题标题" disabled={pending||edit.isPending} value={title} maxLength={160} onChange={event=>setTitle(event.target.value)}/></label><label>完整选题简报<textarea aria-label="完整选题简报" disabled={pending||edit.isPending} value={brief} maxLength={2000} onChange={event=>setBrief(event.target.value)}/></label><label>时间节点<input aria-label="时间节点" disabled={pending||edit.isPending} type="date" value={day} onChange={event=>setDay(event.target.value)}/></label>{error&&<p role="alert" className={styles.error}>{error}</p>}<div className={styles.actionRow}><button disabled={edit.isPending||(!pending&&(!title.trim()||!brief.trim()||!day))} onClick={saveMetadata}>{pending?'恢复原保存':'保存修改'}</button><button disabled={pending||edit.isPending} onClick={()=>setMode('overview')}>取消</button></div></section></div>}
   {mode==='content'&&<div className={styles.contentEditor}><button className={styles.back} onClick={()=>setMode('overview')}>← 返回详情</button><ContentEditor item={{...item,platform:account.platform,account:account.account}} onSaved={onSaved}/></div>}
  </div></div>}
  {history&&<VersionCompare versions={versions} onClose={()=>setHistory(false)}/>}
 </article>;
}

export default function LibraryPage(){
 const [search,setSearch]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[selectedProject,setSelectedProject]=useState(''),[error,setError]=useState(''),[returnHref,setReturnHref]=useState('/positioning'),[focusedItemId,setFocusedItemId]=useState(''),[hydrated,setHydrated]=useState(false);
 const scroll=useRef(0),contentRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{const params=new URL(location.href).searchParams;const target=params.get('returnTo')??sessionStorage.getItem('opc-work-return')??'';const oldSession=params.get('return')??'';const safe=/^\/(runtime\?session=[0-9a-f-]{36}|positioning\/[0-9a-f-]{36}(\/topics)?)([&#?].*)?$/i.test(target)?target:oldSession&&/^[0-9a-f-]{36}$/i.test(oldSession)?'/runtime?session='+oldSession:'/positioning';setReturnHref(safe);setFocusedItemId(params.get('item')??'');try{const value=JSON.parse(sessionStorage.getItem('opc-library-view')??'null') as ViewState|null;if(value){setSearch(value.search);setFrom(value.from);setTo(value.to);setSelectedProject(value.selectedProject);scroll.current=value.scrollTop;}}catch{/* Ignore a stale view preference, not the library data. */}setHydrated(true);},[]);
 useEffect(()=>{if(hydrated)sessionStorage.setItem('opc-library-view',JSON.stringify({search,from,to,selectedProject,scrollTop:scroll.current}));},[hydrated,search,from,to,selectedProject]);
 const library=trpc.opc.library.useQuery({search,from:from||null,to:to||null});
 useEffect(()=>{if(library.data&&contentRef.current&&scroll.current){contentRef.current.scrollTop=scroll.current;}},[library.data]);
 const edit=trpc.opc.editLibrary.useMutation();
 async function updateStage(account:Account,stage:Account['stage']){setError('');try{await edit.mutateAsync({requestId:crypto.randomUUID(),target:'account',targetId:account.projectId,expectedRevision:account.revision,patch:{stage}});await library.refetch();}catch{setError('账号阶段已有新版本。已停止覆盖，请刷新后重试。');}}
 const businesses=(library.data?.businesses??[]) as Business[];
 return <WorkspaceFrame area="library"><main className={styles.page}>
  <header className={styles.header}><div><h1>资料库</h1><p>按平台和账号查看已采用选题与已保存成果。</p></div><Link aria-label="返回当前工作" href={returnHref}>返回当前工作 →</Link></header>
  <div className={styles.catalog}>
   <nav className={styles.catalogNav} aria-label="资料库平台与账号"><button type="button" aria-current={!selectedProject?'page':undefined} onClick={()=>setSelectedProject('')}>全部账号 <span>{businesses.flatMap(b=>b.accounts).reduce((n,a)=>n+a.items.length,0)}</span></button>{[...new Set(businesses.flatMap(b=>b.accounts.map(a=>a.platform)))].map(platform=><div key={platform} className={styles.platform}><strong>{platform}</strong>{businesses.flatMap(b=>b.accounts).filter(a=>a.platform===platform).map(account=><button key={account.projectId} type="button" aria-current={selectedProject===account.projectId?'page':undefined} onClick={()=>setSelectedProject(account.projectId)}>{account.account}<span>{account.items.length}</span></button>)}</div>)}</nav>
   <div ref={contentRef} className={styles.catalogContent} onScroll={event=>{scroll.current=event.currentTarget.scrollTop;if(hydrated)sessionStorage.setItem('opc-library-view',JSON.stringify({search,from,to,selectedProject,scrollTop:scroll.current}));}}>
    <div className={styles.filters}><label><Search size={17}/><input aria-label="查找资料" value={search} onChange={event=>setSearch(event.target.value)} placeholder="查找选题或稿件"/></label><label>开始 <input type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label><label>结束 <input type="date" value={to} onChange={event=>setTo(event.target.value)}/></label></div>
    {library.isLoading&&<p role="status">正在读取资料库…</p>}{library.error&&<p role="alert">资料库当前不可用，或登录已失效。</p>}
    {businesses.map(business=>business.accounts.filter(account=>!selectedProject||account.projectId===selectedProject).map(account=><section key={account.projectId} className={styles.accountSection}><div className={styles.accountHead}><div><h2>{account.platform} · {account.account}</h2><p>{account.items.length} 条已采用选题 · {business.name} · 定位{business.sourceAvailable?'已确认':'待确认'}</p></div><select aria-label={'当前阶段 '+account.account} value={account.stage} onChange={event=>updateStage(account,event.target.value as Account['stage'])}>{Object.entries(stageLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div><div className={styles.items}>{account.items.length?account.items.map(item=><ItemCard key={item.workItemId} item={item} account={account} focused={focusedItemId===item.workItemId} onSaved={()=>library.refetch()}/>):<p className={styles.empty}>这个范围内还没有收录选题。</p>}</div></section>))}
    {!library.isLoading&&!businesses.length&&<p>资料库还是空的。先完成正式定位，再与 Agent 讨论并采用选题。</p>}{error&&<p role="alert">{error}</p>}
   </div>
  </div>
 </main></WorkspaceFrame>;
}
