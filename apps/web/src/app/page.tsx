'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { useCreditsBalance } from '@/hooks/use-credits';
import styles from './home.module.css';

const steps = [
 ['需求确认','先理解你的业务、目标和实际条件。'],
 ['竞品研究','研究相关表达，判断哪些经验值得借鉴。'],
 ['账号定位','明确帮助谁，以及能够提供什么价值。'],
 ['内容策略','把定位变成适合已选平台的内容方向。'],
 ['运营建议','结合时间和能力，安排可持续的工作。'],
 ['商业规划','让内容支持产品与服务，避免只追逐流量。'],
] as const;
type HomeItem={workItemId:string;sessionId:string;title:string;chatName?:string;deleted?:boolean;lastActivityAt?:string};
type HomeAccount={platform:string;account:string;displayName?:string;strategyDraftId?:string|null;items:HomeItem[]};
type HomeBusiness={accounts:HomeAccount[]};

export default function HomePage(){
 const profile=trpc.user.getUserProfile.useQuery();
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null},{retry:false});
 const credits=useCreditsBalance();
 const accounts=((library.data?.businesses??[]) as HomeBusiness[]).flatMap(business=>business.accounts);
 const latestWork=accounts.flatMap(account=>account.items.map(item=>({account,item}))).filter(({item})=>!item.deleted).sort((a,b)=>(b.item.lastActivityAt??'').localeCompare(a.item.lastActivityAt??''))[0];
 const hasStrategy=accounts.some(account=>account.strategyDraftId);
 const name=profile.data?.nickname||profile.data?.email?.split('@')[0]||'用户';
 return <div className={styles.home}>
  <header className={styles.header}><Link href="/" className={styles.brand}><img src="/graylum-logo.png" alt=""/>Graylum</Link><nav aria-label="全局导航"><Link href="/" aria-current="page">首页</Link><Link href="/positioning">对话</Link><Link href="/profile">个人中心</Link></nav><div className={styles.headerEnd}><Link href="/profile?tab=subscription">{credits.status==='ready'?credits.credits:'—'} 积分</Link><Link href="/profile" aria-label="个人中心" className={styles.avatar}>{name.slice(0,1)}</Link></div></header>
  <main className={styles.page}>
   <section className={styles.account}><div><strong>欢迎回来，{name}</strong><span>{profile.data?.membership_level==='free'?'普通会员':'会员账户'}</span></div><Link href="/profile?tab=subscription">账户与积分 →</Link></section>
   {latestWork&&<section className={styles.resume}><p>{latestWork.account.platform} · {latestWork.account.displayName??latestWork.account.account}</p><h2>{latestWork.item.chatName??latestWork.item.title}</h2><div><Link className={styles.primary} href={'/runtime?session='+latestWork.item.sessionId}>继续上次工作</Link><Link href="/library">查看资料库</Link></div></section>}
   <section className={styles.value}><h1>让你的业务，<br/>拥有清楚的内容方向</h1><p>从找到自己的位置，到持续做出有价值的内容。<br/>Graylum 和你一起分析、判断和创作，让每一步都有依据。</p></section>
   <section className={styles.method}><div className={styles.sectionIntro}><h2>六个环节，理解你的内容增长路径</h2><p>Agent 提供分析与建议，你核对真实情况、作出关键决定。</p></div><ol>{steps.map(([title,description],index)=><li key={title}><span>{String(index+1).padStart(2,'0')}</span><h3>{title}</h3><p>{description}</p></li>)}</ol></section>
   <section className={styles.entry}><div><Link className={styles.primary} href="/positioning">{hasStrategy?'进入对话':'开始新手引导'}</Link><Link href={hasStrategy?'/library':'/positioning'}>{hasStrategy?'查看正式定位':'我已有定位'}</Link></div><p>{hasStrategy?'已有定位和工作会保留；你可以继续原对话。':'先一起确认定位，再开展选题和内容创作。已有资料可以直接带入。'}</p></section>
   <section className={styles.capabilities}><h2>从策略，继续走向实际创作</h2><div>{[['AI 对话','持续讨论，获得建议'],['内容创作','选题、起草、修改与定稿'],['功能广场','探索工具与方法'],['个人成长','回看自己的创作历程']].map(([title,description])=><article key={title}><h3>{title}</h3><p>{description}</p></article>)}</div></section>
  </main>
 </div>;
}
