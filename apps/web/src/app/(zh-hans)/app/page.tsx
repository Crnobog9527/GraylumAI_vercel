'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { useRef } from 'react';
import { ArrowRight, LayoutGrid, MessageCircle, PenLine, TrendingUp } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { useCreditsBalance } from '@/hooks/use-credits';
import { accountDisplayName, membershipText } from '@/lib/account-presentation';
import styles from './home.module.css';
import { QueryNotice } from '@/components/opc/query-notice';
import { LanguageSwitch } from '@/components/layout/LanguageSwitch';
import { AnnouncementBar, GlobalHeader } from '@/components/opc/rail-view';
import { useAnnouncementOpen } from '@/components/opc/use-announcement';
import { PhoneTabs } from '@/components/opc/phone-tabs';
import { AccountAvatar } from '@/components/profile/AccountAvatar';
import { HomeMethod } from './home-method';
import { startEntryHref, type StartMode } from './positioning/start-entry';

/** What the product goes on to do after positioning. Named, not linked: these are not entries (home.module.css). */
const CAPABILITIES=[['AI 对话','持续讨论，获得建议',MessageCircle],['内容创作','选题、起草、修改与定稿',PenLine],
 ['功能广场','探索工具与方法',LayoutGrid],['个人成长','回看自己的创作历程',TrendingUp]] as const;

type HomeAccount={strategyDraftId?:string|null};
type HomeBusiness={accounts:HomeAccount[]};

export default function HomePage(){
 const startIntent=useRef<string|null>(null);
 // The announcement of the signed-in pages, here too (Owner 2026-11-12): the one message (lib/announcement.ts) and the one
 // record of closing it (use-announcement.ts), so closing it on either page closes it on both. The public home page has none.
 const [noticeOpen,closeNotice]=useAnnouncementOpen();
 // One click starts one draft: the intent id is the start request id (从头分析, or 我已有定位 for R15).
 const startOnce=(event:{preventDefault:()=>void},mode:StartMode)=>{event.preventDefault();if(startIntent.current)return;
  startIntent.current=crypto.randomUUID();location.assign(startEntryHref(mode,startIntent.current));};
 const profile=trpc.user.getUserProfile.useQuery();
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{retry:false});
 const credits=useCreditsBalance();
 const accounts=((library.data?.businesses??[]) as HomeBusiness[]).flatMap(business=>business.accounts);
 const libraryReady=library.isSuccess&&!library.error;
 const hasStrategy=accounts.some(account=>account.strategyDraftId);
 const name=accountDisplayName(profile);
 return <div className={styles.home}>
  {/* The page's light: it lies behind everything, the whole width of the screen (home.module.css). */}
  <div className={styles.glow} aria-hidden="true"><i/><i/><i/></div>
  {/* The shared top bar of the workbench (GlobalHeader); the home page has no rail, so its phone menu button is hidden in home.module.css. */}
  <GlobalHeader area="search" end={<div className={styles.headerEnd}><LanguageSwitch className={styles.language}/><Link href="/app/profile?tab=subscription">{credits.status==='ready'?credits.credits:'—'} 积分</Link><Link href="/app/profile" aria-label="个人中心" className={styles.avatar}><AccountAvatar url={profile.data?.avatar_url} initial={(name??'我').slice(0,1)}
    style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', borderRadius: 'inherit' }}/></Link></div>}/>
  {noticeOpen&&<AnnouncementBar onClose={closeNotice}/>}
  <main className={styles.page}>
   <section className={styles.account}><div><strong>{name?`你好，${name}`:'你好'}</strong><span>{membershipText(profile)}</span></div><Link href="/app/profile?tab=subscription">账户与积分 →</Link></section>
   <section className={styles.value}><h1>让你的业务，<br/>拥有清楚的内容方向</h1><p>从找到自己的位置，到持续做出有价值的内容。<br/>Graylum 和你一起分析、判断和创作，让每一步都有依据。</p></section>
   {/* Owner-approved promotional method introduction; not the executed /positioning workflow. */}
   <HomeMethod/>
   <section className={styles.entry}><div><Link className={styles.primary} href="/app/positioning" onClick={event=>{if(libraryReady&&!hasStrategy)startOnce(event,'mentor');}}>{!libraryReady||hasStrategy?'进入对话':'开始新手引导'}<ArrowRight size={17} aria-hidden="true"/></Link><Link href={!libraryReady||hasStrategy?'/app/library':'/app/positioning'} onClick={event=>{if(libraryReady&&!hasStrategy)startOnce(event,'manual');}}>{!libraryReady?'查看资料库':hasStrategy?'查看正式定位':'我已有定位'}</Link></div><QueryNotice error={library.error} loading={library.isPending} label="账号与资料" retry={()=>library.refetch()}/>{libraryReady&&<p>{hasStrategy?'已有定位和工作会保留；你可以继续原对话。':'先一起确认定位，再开展选题和内容创作。已有资料可以直接带入。'}</p>}</section>
   <section className={styles.capabilities}><h2>从策略，继续走向实际创作</h2><div>{CAPABILITIES.map(([title,description,Mark])=><article key={title}>
    <Mark size={19} strokeWidth={1.8} aria-hidden="true"/><h3>{title}</h3><p>{description}</p></article>)}</div></section>
  </main>
  {/* A phone's bottom bar (phone plan A); the page's foot leaves it room in home.module.css. */}
  <PhoneTabs on="home"/>
 </div>;
}
