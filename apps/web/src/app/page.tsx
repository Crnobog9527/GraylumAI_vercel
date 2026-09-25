'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { useCreditsBalance } from '@/hooks/use-credits';
import styles from './home.module.css';

type HomeAccount={strategyDraftId?:string|null};
type HomeBusiness={accounts:HomeAccount[]};

export default function HomePage(){
 const profile=trpc.user.getUserProfile.useQuery();
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{retry:false});
 const catalog=trpc.opc.catalog.useQuery();
 const credits=useCreditsBalance();
 const accounts=((library.data?.businesses??[]) as HomeBusiness[]).flatMap(business=>business.accounts);
 const hasStrategy=accounts.some(account=>account.strategyDraftId);
 const name=profile.data?.nickname||profile.data?.email?.split('@')[0]||'用户';
 const steps=catalog.data?.[0]?.workflow.steps??[];
 const stepCount=['零','一','二','三','四','五','六','七','八','九','十'][steps.length]??String(steps.length);
 return <div className={styles.home}>
  <header className={styles.header}><Link href="/" className={styles.brand}><img src="/graylum-logo.png" alt=""/>Graylum</Link><nav aria-label="全局导航"><Link href="/" aria-current="page">首页</Link><Link href="/positioning">对话</Link><Link href="/profile">个人中心</Link></nav><div className={styles.headerEnd}><Link href="/profile?tab=subscription">{credits.status==='ready'?credits.credits:'—'} 积分</Link><Link href="/profile" aria-label="个人中心" className={styles.avatar}>{name.slice(0,1)}</Link></div></header>
  <main className={styles.page}>
   <section className={styles.account}><div><strong>欢迎回来，{name}</strong><span>{profile.data?.membership_level==='free'?'普通会员':'会员账户'}</span></div><Link href="/profile?tab=subscription">账户与积分 →</Link></section>
   <section className={styles.value}><h1>让你的业务，<br/>拥有清楚的内容方向</h1><p>从找到自己的位置，到持续做出有价值的内容。<br/>Graylum 和你一起分析、判断和创作，让每一步都有依据。</p></section>
   <section className={styles.method}><div className={styles.sectionIntro}><h2>{steps.length?`${stepCount}个环节，理解你的内容增长路径`:'定位方法准备中'}</h2><p>Agent 提供分析与建议，你核对真实情况、作出关键决定。</p></div>{steps.length>0&&<ol>{steps.map((step,index)=><li key={step.id}><span>{String(index+1).padStart(2,'0')}</span><h3>{step.title}</h3><p>具体问题将在进入定位工作后呈现。</p></li>)}</ol>}</section>
   <section className={styles.entry}><div><Link className={styles.primary} href="/positioning">{hasStrategy?'进入对话':'开始新手引导'}</Link><Link href={hasStrategy?'/library':'/positioning'}>{hasStrategy?'查看正式定位':'我已有定位'}</Link></div><p>{hasStrategy?'已有定位和工作会保留；你可以继续原对话。':'先一起确认定位，再开展选题和内容创作。已有资料可以直接带入。'}</p></section>
   <section className={styles.capabilities}><h2>从策略，继续走向实际创作</h2><div>{[['AI 对话','持续讨论，获得建议'],['内容创作','选题、起草、修改与定稿'],['功能广场','探索工具与方法'],['个人成长','回看自己的创作历程']].map(([title,description])=><article key={title}><h3>{title}</h3><p>{description}</p></article>)}</div></section>
  </main>
 </div>;
}
