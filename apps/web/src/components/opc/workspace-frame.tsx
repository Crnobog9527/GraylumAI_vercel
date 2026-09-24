'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, CalendarDays, ChartNoAxesColumnIncreasing, ChevronDown, Grid2X2, Menu, PanelRightClose, Pin, Search, X } from 'lucide-react';
import { trpc } from '@/trpc/client';
import styles from './workspace-frame.module.css';

type Item = {workItemId:string;sessionId:string;title:string;lastActivityAt?:string};
type Account = {projectId:string;platform:string;account:string;strategyDraftId?:string|null;items:Item[]};
type Business = {businessId:string;accounts:Account[]};

/** The accepted U0/U1 shell, with real owned OPC projections instead of demo state. */
export function WorkspaceFrame({children,right,rightOpen=true,onToggleRight,activeWorkItemId,area='chat',notice}:{
 children:ReactNode;right?:ReactNode;rightOpen?:boolean;onToggleRight?:()=>void;
 activeWorkItemId?:string;area?:'chat'|'library'|'topics'|'marketplace'|'start';notice?:string;
}){
 const [mobileNav,setMobileNav]=useState(false),[mobileRight,setMobileRight]=useState(false),[query,setQuery]=useState('');
 const searchRef=useRef<HTMLInputElement>(null);
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
 const businesses=(library.data?.businesses??[]) as Business[];
 const platforms=new Map<string,Account[]>();
 for(const business of businesses)for(const account of business.accounts){
  const group=platforms.get(account.platform)??[];group.push(account);platforms.set(account.platform,group);
 }
 return <div className={styles.workspace}>
  <header className={styles.global}>
   <Link href="/" className={styles.brand}><img src="/graylum-logo.png" alt="" />Graylum</Link>
   <nav aria-label="全局导航"><Link href="/">首页</Link><Link href="/positioning" aria-current={area==='chat'||area==='topics'||area==='start'?'page':undefined}>对话</Link><Link href="/profile">个人中心</Link></nav>
  </header>
  <div className={styles.announcement}>{notice&&<span>{notice}</span>}<strong>让好想法，继续向前。</strong></div>
  <div className={[styles.shell,right&&rightOpen?styles.withRight:'',mobileNav?styles.navOpen:'',mobileRight?styles.mobileRightOpen:''].join(' ')}>
   <aside className={styles.rail} aria-label="工作区导航">
    <div className={styles.railMobile}><strong>工作区</strong><button aria-label="关闭导航" onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
    <a className={styles.newConversation} href="/positioning?new=1">＋ 新对话</a>
    <nav className={styles.railNav} aria-label="工作区功能">
     <Link href={'/workbench/marketplace'+returnParam} aria-current={area==='marketplace'?'page':undefined}><Grid2X2 size={17}/>功能广场</Link>
     <button onClick={()=>searchRef.current?.focus()}><Search size={17}/>搜索</button>
     <Link href={'/library'+returnParam} aria-current={area==='library'?'page':undefined}><BookOpen size={17}/>资料库</Link>
     <button disabled><CalendarDays size={17}/>发布排期 <small>待接入</small></button>
     <button disabled><ChartNoAxesColumnIncreasing size={17}/>数据复盘 <small>待接入</small></button>
    </nav>
    <label className={styles.search}><Search size={14}/><input ref={searchRef} aria-label="查找账号或工作" placeholder="查找账号或工作" value={query} onChange={event=>setQuery(event.target.value)}/></label>
    <div className={styles.history} aria-label="平台、账号与工作">
     {[...platforms].map(([platform,accounts])=>{
      const visible=accounts.map(account=>({account,
       items:account.items.filter(item=>(account.account+' '+item.title).toLowerCase().includes(query.toLowerCase()))
        .sort((a,b)=>(b.lastActivityAt??'').localeCompare(a.lastActivityAt??''))}))
       .filter(row=>!query||row.items.length||row.account.account.toLowerCase().includes(query.toLowerCase()));
      if(!visible.length)return null;
      return <details key={platform} open={Boolean(query)||visible.some(row=>row.items.some(item=>item.workItemId===activeWorkItemId))}>
       <summary>{platform}<ChevronDown size={14}/></summary>
       {visible.map(({account,items})=>{
        return <details key={account.projectId} open={Boolean(query)||items.some(item=>item.workItemId===activeWorkItemId)} className={styles.account}>
         <summary>{account.account}<ChevronDown size={13}/></summary>
         {account.strategyDraftId&&<Link className={styles.strategy} href={'/positioning/'+account.strategyDraftId}><Pin size={12}/>定位策略 <small>当前账号依据</small></Link>}
         {items.map(item=><Link key={item.workItemId} className={styles.thread} aria-current={activeWorkItemId===item.workItemId?'page':undefined} href={'/runtime?session='+item.sessionId}><span>{item.title}</span></Link>)}
        </details>;
       })}
      </details>;
     })}
     {!library.isLoading&&!platforms.size&&<p className={styles.empty}>完成定位并采用选题后，账号工作会出现在这里。</p>}
    </div>
    <div className={styles.railBottom}><Link href="/profile">个人中心</Link></div>
   </aside>
   <section className={styles.center}>
    <div className={styles.mobileBar}><button aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={19}/></button><span>Graylum · 工作区</span>{right&&<button onClick={()=>{if(!rightOpen)onToggleRight?.();setMobileRight(true);}} aria-label="打开成果"><BookOpen size={18}/></button>}</div>
    {children}
   </section>
   {right&&rightOpen&&<aside className={styles.right} aria-label="当前成果"><div className={styles.rightToggle}><button aria-label="收起成果面板" onClick={()=>{if(window.matchMedia('(max-width:700px)').matches)setMobileRight(false);else onToggleRight?.();}}><PanelRightClose size={18}/></button></div>{right}</aside>}
  </div>
 </div>;
}
