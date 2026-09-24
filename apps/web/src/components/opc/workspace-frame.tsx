'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, CalendarDays, ChartNoAxesColumnIncreasing, ChevronDown, Ellipsis, Grid2X2, Menu, PanelRightClose, Pin, Search, Sparkles, Ticket, Wallet, X } from 'lucide-react';
import { trpc } from '@/trpc/client';
import styles from './workspace-frame.module.css';

type Item = {workItemId:string;sessionId:string;title:string;brief:string|null;day:string;revision:number;contentType?:string;lastActivityAt?:string};
type Account = {projectId:string;platform:string;account:string;strategyDraftId?:string|null;items:Item[]};
type Business = {businessId:string;accounts:Account[]};
type Draft = {draftId:string;businessName?:string;createdAt?:string;currentVersion?:number;state?:string};
const definiteRenameErrors=new Set(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID','OPC_CONTENT_DENIED','OPC_CONTENT_INVALID','OPC_CONTENT_SOURCE']);

/** The accepted U0/U1 shell, with real owned OPC projections instead of demo state. */
export function WorkspaceFrame({children,right,rightOpen=true,onToggleRight,activeWorkItemId,area='chat',notice}:{
 children:ReactNode;right?:ReactNode;rightOpen?:boolean;onToggleRight?:()=>void;
 activeWorkItemId?:string;area?:'chat'|'library'|'topics'|'marketplace'|'start';notice?:string;
}){
 const [mobileNav,setMobileNav]=useState(false),[mobileRight,setMobileRight]=useState(false),[query,setQuery]=useState('');
 const [archiveView,setArchiveView]=useState(false),[menuId,setMenuId]=useState(''),[menuPosition,setMenuPosition]=useState({top:0,left:0}),[renameId,setRenameId]=useState(''),[renameValue,setRenameValue]=useState(''),[renameError,setRenameError]=useState('');
 const [expanded,setExpanded]=useState<string[]>([]);
 const [noticeOpen,setNoticeOpen]=useState(true);
 const [groupOpen,setGroupOpen]=useState<Record<string,boolean>>({});
 const searchRef=useRef<HTMLInputElement>(null);
 const cancelRenameRef=useRef(false);
 const pathname=usePathname();
 const [workReturn,setWorkReturn]=useState('');
 useEffect(()=>{
  const current=location.pathname+location.search;
  if(/^\/(runtime|positioning\/[^/?]+)(\/topics)?(?:[?]|$)/.test(current)){
   sessionStorage.setItem('opc-work-return',current);setWorkReturn(current);
  }else setWorkReturn(sessionStorage.getItem('opc-work-return')??'');
 },[pathname,activeWorkItemId]);
 const returnParam=workReturn?'?returnTo='+encodeURIComponent(workReturn):'';
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null});
 const drafts=trpc.opc.list.useQuery();
 const edit=trpc.opc.editLibrary.useMutation();
 const profile=trpc.user.getUserProfile.useQuery();
 const businesses=(library.data?.businesses??[]) as Business[];
 const platforms=new Map<string,Account[]>();
 for(const business of businesses)for(const account of business.accounts){
  const group=platforms.get(account.platform)??[];group.push(account);platforms.set(account.platform,group);
 }
 const assigned=new Set([...platforms.values()].flat().map(account=>account.strategyDraftId).filter(Boolean));
 const unassigned=((drafts.data?.drafts??[]) as Draft[]).filter(draft=>!assigned.has(draft.draftId)&&(!query||(`${draft.businessName??''} 定位`).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
 async function saveRename(item:Item){
  const title=renameValue.trim();if(!title||title===item.title){setRenameId('');return;}
  const key='opc-library-edit:'+item.workItemId;
  setRenameError('');
  try{await navigator.locks.request(key,async()=>{
   const raw=localStorage.getItem(key);
   const request=raw?JSON.parse(raw):{requestId:crypto.randomUUID(),target:'item' as const,targetId:item.workItemId,expectedRevision:item.revision,patch:{title,brief:item.brief??'',day:item.day,...(item.contentType?{contentType:item.contentType}:{})}};
   localStorage.setItem(key,JSON.stringify(request));
   await edit.mutateAsync(request);localStorage.removeItem(key);await library.refetch();setRenameId('');
  });}catch(cause){const code=cause instanceof Error?cause.message:'';if(definiteRenameErrors.has(code)){localStorage.removeItem(key);await library.refetch();setRenameError('重命名被拒绝（'+code+'）。输入仍保留，请核对资料库中的当前名称。');}else setRenameError('名称保存未确认。原请求已保留，请先核对资料库中的当前名称，再重试。');}
 }
 function recordMenu(item:Item){return <div className={styles.threadRow} key={item.workItemId}>
  {renameId===item.workItemId?<input className={styles.renameInput} aria-label={'重命名'+item.title} value={renameValue} maxLength={160} autoFocus onChange={event=>setRenameValue(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}if(event.key==='Escape'){cancelRenameRef.current=true;setRenameId('');event.currentTarget.blur();}}} onBlur={()=>{if(cancelRenameRef.current){cancelRenameRef.current=false;return;}if(renameId===item.workItemId)void saveRename(item);}}/>:<Link className={styles.thread} aria-current={activeWorkItemId===item.workItemId?'page':undefined} href={'/runtime?session='+item.sessionId}><span>{item.title}</span><small>{item.lastActivityAt?new Date(item.lastActivityAt).toLocaleDateString('zh-CN'):''} · 工作对话</small></Link>}
  <button className={styles.more} aria-label={item.title+'的更多操作'} aria-expanded={menuId===item.workItemId} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenuPosition({top:Math.max(8,Math.min(window.innerHeight-166,rect.bottom+4)),left:Math.max(8,Math.min(window.innerWidth-186,rect.right-178))});setMenuId(current=>current===item.workItemId?'':item.workItemId);}}><Ellipsis size={17}/></button>
  {menuId===item.workItemId&&<div className={styles.workMenu} style={menuPosition} role="menu"><button role="menuitem" onClick={()=>{setRenameId(item.workItemId);setRenameValue(item.title);setMenuId('');}}>重命名</button><button role="menuitem" disabled>置顶 · 待接入</button><button role="menuitem" disabled>归档 · 待接入</button><button role="menuitem" className={styles.danger} disabled>删除 · 待接入</button></div>}
 </div>}
 return <div className={styles.workspace}>
  <header className={styles.global}>
   <Link href="/" className={styles.brand}><img src="/graylum-logo.png" alt="" />Graylum</Link>
   <nav aria-label="全局导航"><Link href="/">首页</Link><Link href="/positioning" aria-current={area==='chat'||area==='topics'||area==='start'?'page':undefined}>对话</Link><Link href="/profile">个人中心</Link></nav>
  </header>
  {noticeOpen&&<div className={styles.announcement}>{notice&&<span>{notice}</span>}<Sparkles size={15}/><strong>让好想法，继续向前。</strong><Link href={'/workbench/marketplace'+returnParam}>探索创作功能</Link><button aria-label="关闭公告" onClick={()=>setNoticeOpen(false)}><X size={15}/></button></div>}
  <div className={[styles.shell,right&&rightOpen?styles.withRight:'',mobileNav?styles.navOpen:'',mobileRight?styles.mobileRightOpen:'',!noticeOpen?styles.noNotice:''].join(' ')}>
   <aside className={styles.rail} aria-label="工作区导航">
    <div className={styles.railMobile}><strong>工作区</strong><button aria-label="关闭导航" onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
    <Link className={styles.newConversation} href="/positioning">＋ 新对话</Link>
    <nav className={styles.railNav} aria-label="工作区功能">
     <Link href={'/workbench/marketplace'+returnParam} aria-current={area==='marketplace'?'page':undefined}><Grid2X2 size={17}/>功能广场</Link>
     <button onClick={()=>{setArchiveView(false);searchRef.current?.focus()}}><Search size={17}/>搜索</button>
     <Link href={'/library'+returnParam} aria-current={area==='library'?'page':undefined}><BookOpen size={17}/>资料库</Link>
     <button disabled><CalendarDays size={17}/>发布排期 <small>待接入</small></button>
     <button disabled><ChartNoAxesColumnIncreasing size={17}/>数据复盘 <small>待接入</small></button>
    </nav>
    <div className={styles.historyHead}><span>{archiveView?'归档记录':'平台 · 账号 · 工作'}</span><button onClick={()=>setArchiveView(value=>!value)}>{archiveView?'返回最近工作':'查看归档'}</button></div>
    <label className={styles.searchLabel} htmlFor="workspace-work-search">查找账号或工作</label>
    <label className={styles.search}><Search size={14}/><input id="workspace-work-search" ref={searchRef} aria-label="查找账号或工作" placeholder="搜索账号、工作" value={query} onChange={event=>setQuery(event.target.value)}/></label>
    <div className={styles.history} aria-label="平台、账号与工作" onScroll={()=>setMenuId('')}>
     {archiveView?<p className={styles.empty}>归档记录查询与恢复尚未接入正式工作区。现有工作不会被移动或删除。</p>:[...platforms].map(([platform,accounts])=>{
      const visible=accounts.map(account=>({account,
       items:account.items.filter(item=>(account.account+' '+item.title+' '+platform).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .sort((a,b)=>(b.lastActivityAt??'').localeCompare(a.lastActivityAt??''))}))
       .filter(row=>!query||row.items.length||row.account.account.toLocaleLowerCase().includes(query.toLocaleLowerCase())||platform.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      if(!visible.length)return null;
      return <details key={platform} open={groupOpen['platform:'+platform]??true} onToggle={event=>{const next=event.currentTarget.open;setGroupOpen(current=>current['platform:'+platform]===next?current:{...current,['platform:'+platform]:next});}}>
       <summary>{platform}<ChevronDown size={14}/></summary>
       {visible.map(({account,items})=>{
        const shown=query||expanded.includes(account.projectId)?items:items.slice(0,6);
        const strategy=((drafts.data?.drafts??[]) as Draft[]).find(draft=>draft.draftId===account.strategyDraftId);
        return <details key={account.projectId} open={groupOpen['account:'+account.projectId]??true} onToggle={event=>{const next=event.currentTarget.open;setGroupOpen(current=>current['account:'+account.projectId]===next?current:{...current,['account:'+account.projectId]:next});}} className={styles.account}>
         <summary>{account.account}<ChevronDown size={13}/></summary>
         {account.strategyDraftId?<Link className={styles.strategy} href={'/positioning/'+account.strategyDraftId}><span><Pin size={12}/>定位策略</span><small>{strategy?.currentVersion?`当前 v${strategy.currentVersion}`:'进行中'} · {account.account}</small></Link>:<p className={styles.empty}>定位策略待建立</p>}
         {shown.map(recordMenu)}
         {shown.length<items.length&&<button className={styles.older} onClick={()=>setExpanded(current=>[...current,account.projectId])}>查看更早 {items.length-shown.length} 项</button>}
        </details>;
       })}
      </details>;
     })}
     {!archiveView&&unassigned.length>0&&<details open={groupOpen.unassigned??true} onToggle={event=>{const next=event.currentTarget.open;setGroupOpen(current=>current.unassigned===next?current:{...current,unassigned:next});}}><summary>待归类<ChevronDown size={14}/></summary>{unassigned.map(draft=><Link key={draft.draftId} className={styles.thread} href={'/positioning/'+draft.draftId}><span>{draft.businessName??'新账号'} · 定位分析</span><small>{draft.state==='published'?'已确认':'进行中'}</small></Link>)}</details>}
     {!archiveView&&!library.isLoading&&!platforms.size&&!unassigned.length&&<p className={styles.empty}>完成定位并采用选题后，账号工作会出现在这里。</p>}
     {renameError&&<p className={styles.empty} role="alert">{renameError}</p>}
    </div>
    <div className={styles.railBottom}><div className={styles.creditWidget}><Link href="/profile?tab=tickets"><Ticket size={15}/>在线反馈</Link><Link href="/profile?tab=credits"><Wallet size={15}/>积分 <small>查看</small></Link></div><Link className={styles.profile} href="/profile"><span className={styles.avatar}>{(profile.data?.nickname??profile.data?.email??'我').slice(0,1)}</span><span>{profile.data?.nickname??profile.data?.email??'个人中心'}<small>查看账户</small></span><ChevronDown size={14}/></Link></div>
   </aside>
   <section className={styles.center}>
    <div className={styles.mobileBar}><button aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={19}/></button><span>Graylum · 工作区</span>{right&&<button onClick={()=>{if(!rightOpen)onToggleRight?.();setMobileRight(true);}} aria-label="打开成果"><BookOpen size={18}/></button>}</div>
    {children}
   </section>
   {right&&rightOpen&&<aside className={styles.right} aria-label="当前成果"><div className={styles.rightToggle}><button aria-label="收起成果面板" onClick={()=>{if(window.matchMedia('(max-width:700px)').matches)setMobileRight(false);else onToggleRight?.();}}><PanelRightClose size={18}/></button></div>{right}</aside>}
  </div>
 </div>;
}
