'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { useRef } from 'react';
import { trpc } from '@/trpc/client';
import { useCreditsBalance } from '@/hooks/use-credits';
import { accountDisplayName, membershipText } from '@/lib/account-presentation';
import styles from './home.module.css';
import { QueryNotice } from '@/components/opc/query-notice';
import { HOME_STEP_LABELS, HOME_STEPS } from './home-steps';

type HomeAccount={strategyDraftId?:string|null};
type HomeBusiness={accounts:HomeAccount[]};

export default function HomePage(){
 const startIntent=useRef<string|null>(null);
 const profile=trpc.user.getUserProfile.useQuery();
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{retry:false});
 const credits=useCreditsBalance();
 const accounts=((library.data?.businesses??[]) as HomeBusiness[]).flatMap(business=>business.accounts);
 const libraryReady=library.isSuccess&&!library.error;
 const hasStrategy=accounts.some(account=>account.strategyDraftId);
 const name=accountDisplayName(profile);
 return <div className={styles.home}>
  <header className={styles.header}><Link href="/" className={styles.brand}><img src="/graylum-logo.png" alt=""/>Graylum</Link><nav aria-label="全局导航"><Link href="/" aria-current="page">首页</Link><Link href="/positioning">对话</Link><Link href="/profile">个人中心</Link></nav><div className={styles.headerEnd}><Link href="/profile?tab=subscription">{credits.status==='ready'?credits.credits:'—'} 积分</Link><Link href="/profile" aria-label="个人中心" className={styles.avatar}>{(name??'我').slice(0,1)}</Link></div></header>
  <main className={styles.page}>
   <section className={styles.account}><div><strong>{name?`欢迎回来，${name}`:'欢迎回来'}</strong><span>{membershipText(profile)}</span></div><Link href="/profile?tab=subscription">账户与积分 →</Link></section>
   <section className={styles.value}><h1>让你的业务，<br/>拥有清楚的内容方向</h1><p>从找到自己的位置，到持续做出有价值的内容。<br/>Graylum 和你一起分析、判断和创作，让每一步都有依据。</p></section>
   <section className={styles.method} aria-label="定位工作步骤">
    <ol>
     {HOME_STEPS.map((step,index)=><li key={step.title}>
      <span className={styles.stepNumber}>{String(index+1).padStart(2,'0')}</span>
      <h3>{step.title}</h3>
      <dl>{HOME_STEP_LABELS.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{step[key]}</dd></div>)}</dl>
     </li>)}
    </ol>
   </section>
   <section className={styles.entry}><div><Link className={styles.primary} href="/positioning" onClick={event=>{if(libraryReady&&!hasStrategy){event.preventDefault();if(startIntent.current)return;startIntent.current=crypto.randomUUID();location.assign('/positioning?start=mentor&intent='+startIntent.current);}}}>{!libraryReady||hasStrategy?'进入对话':'开始新手引导'}</Link><Link href={!libraryReady||hasStrategy?'/library':'/positioning'}>{!libraryReady?'查看资料库':hasStrategy?'查看正式定位':'我已有定位'}</Link></div><QueryNotice error={library.error} loading={library.isPending} label="账号与资料" retry={()=>library.refetch()}/>{libraryReady&&<p>{hasStrategy?'已有定位和工作会保留；你可以继续原对话。':'先一起确认定位，再开展选题和内容创作。已有资料可以直接带入。'}</p>}</section>
   <section className={styles.capabilities}><h2>从策略，继续走向实际创作</h2><div>{[['AI 对话','持续讨论，获得建议'],['内容创作','选题、起草、修改与定稿'],['功能广场','探索工具与方法'],['个人成长','回看自己的创作历程']].map(([title,description])=><article key={title}><h3>{title}</h3><p>{description}</p></article>)}</div></section>
  </main>
 </div>;
}
