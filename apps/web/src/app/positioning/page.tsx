"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase";
import { CalendarDays, ChartNoAxesColumnIncreasing, Sparkles, Target, X } from 'lucide-react';
import { WorkspaceFrame } from "@/components/opc/workspace-frame";
import styles from './start-work.module.css';
import { useRouter } from "next/navigation";
import { WorkComposer, useFreeConversation } from '@/components/opc/work-composer';
type StartOperation={actorId:string;requestId:string;registration:string;mode:"mentor"|"manual";businessId:string|null;businessName?:string};
type StartAccount={projectId:string;platform:string;account:string;businessName:string;strategyDraftId?:string|null;sourceVersionId?:string|null;pendingStrategyDraftId?:string|null;sourceVersion?:number;displayName?:string;profile?:Record<string,{value?:string;label?:string;status?:string}>|null;items:Array<{workItemId:string;sessionId:string;title:string}>};
const startOperationKey="opc-start-operation";
export default function PositioningHome() {
  const router = useRouter();
  const free = useFreeConversation();
  const [skillId,setSkillId]=useState('');
  const catalog = trpc.opc.catalog.useQuery(),
    list = trpc.opc.list.useQuery(),
    library = trpc.opc.library.useQuery({ search: "", from: null, to: null }),
    start = trpc.opc.start.useMutation();
  const [businessName, setBusinessName] = useState(""),
    [showStart,setShowStart]=useState(false),
    [methodDialog,setMethodDialog]=useState(false),
    [showSource,setShowSource]=useState(false),
    [intent,setIntent]=useState<'topics'|'content'|'position'|''>(''),
    [startInput,setStartInput]=useState(''),
    [recommendation,setRecommendation]=useState<'all'|'strategy'|'writing'|'operations'>('all'),
    [workReturn,setWorkReturn]=useState(''),
    [sourceAccount,setSourceAccount]=useState(''),
    [error, setError] = useState(""),
    [actorId,setActorId]=useState(""),
    [pendingStart,setPendingStart]=useState<StartOperation|null>(null);
  useEffect(()=>{const client=createClient();let alive=true;void client.auth.getUser().then(({data})=>{if(alive)setActorId(data.user?.id??"");});const {data:{subscription}}=client.auth.onAuthStateChange((_event,session)=>{if(alive)setActorId(session?.user.id??"");});return()=>{alive=false;subscription.unsubscribe();};},[]);
  useEffect(()=>{setStartInput(sessionStorage.getItem('opc-new-task-input')??'');},[]);
  useEffect(()=>{const account=new URL(location.href).searchParams.get('account');if(account&&/^[0-9a-f-]{36}$/i.test(account)){setSourceAccount(account);setIntent('topics');setShowSource(true);}},[]);
  useEffect(()=>{const value=sessionStorage.getItem('opc-work-return')??'';setWorkReturn(/^\/(runtime\?session=[0-9a-f-]{36}|positioning\/[0-9a-f-]{36}(\/topics)?)([&#?].*)?$/i.test(value)?value:'');},[]);
  useEffect(()=>{setPendingStart(null);if(!actorId)return;const legacy=sessionStorage.getItem(startOperationKey);if(legacy){sessionStorage.setItem(startOperationKey+":legacy:"+Date.now(),legacy);sessionStorage.removeItem(startOperationKey);}const key=startOperationKey+":"+actorId,raw=sessionStorage.getItem(key);if(!raw)return;try{const op:StartOperation=JSON.parse(raw);if(op.actorId===actorId)setPendingStart(op);}catch{sessionStorage.removeItem(key);}},[actorId]);
  useEffect(()=>{if(!methodDialog&&!showStart)return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMethodDialog(false);setShowStart(false);}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[methodDialog,showStart]);
  async function runStart(op:StartOperation){
    if(!actorId||op.actorId!==actorId){setError("登录账号已变化，请切回原账号恢复该请求。");return;}
    const key=startOperationKey+":"+actorId;
    setError("");sessionStorage.setItem(key,JSON.stringify(op));setPendingStart(op);
    try {
      const {actorId:_,...request}=op;void _;const d=await start.mutateAsync(request);
      sessionStorage.removeItem(key);setPendingStart(null);location.href="/positioning/"+d.draftId;
    } catch { setError("未能建立定位草稿。完整的原开始请求已保留，请恢复该请求。"); }
  }
  async function begin() {
    if(pendingStart){setError("请先恢复上次开始请求；恢复完成后再选择其他业务。");return;}
    const registration = catalog.data?.[0]?.id;
    if (!registration) return;
    if(!actorId)return;
    await runStart({actorId,requestId:crypto.randomUUID(),registration,mode:"mentor",businessId:null,businessName:businessName.trim()});
  }
  const accounts:StartAccount[]=(library.data?.businesses??[]).flatMap((business:{name:string;accounts:Array<Omit<StartAccount,'businessName'>>})=>business.accounts.map(account=>({...account,businessName:business.name})));
  const topicAccounts=accounts.flatMap(account=>{
    const strategy=(list.data?.drafts??[]).find((draft:{draftId:string;state:string;currentVersion?:number})=>draft.draftId===account.strategyDraftId);
    // A revision opens a new draft round without deleting its previously
    // confirmed version. Keep the owned topic entry reachable; the topic page
    // and server still decide whether an existing binding can continue or a
    // new one may be created from the current published round.
    return strategy&&(strategy.state==='published'||(strategy.currentVersion??0)>0)?[{...account,strategyState:strategy.state}]:[];
  });
  function chooseTopics(){setIntent('topics');setShowSource(true);setShowStart(false);if(!startInput.trim()){const value='请基于当前账号定位，帮我策划下一批选题。';setStartInput(value);sessionStorage.setItem('opc-new-task-input',value);}}
  function choosePosition(){setMethodDialog(true);setIntent('position');setShowSource(false);setShowStart(false);if(!startInput.trim()){const value='我想梳理一个账号的定位，请从需要确认的问题开始。';setStartInput(value);sessionStorage.setItem('opc-new-task-input',value);}}
  return (
    <WorkspaceFrame area="start"><main className={styles.page}><header className={styles.startTop}><strong>我的增长工作</strong>{workReturn&&<Link href={workReturn}>返回当前工作 →</Link>}</header><div className={styles.content}>
      <header className={styles.hero}><h1>今天，想推进什么？</h1></header>
      <section className={styles.actions} aria-label="选择新任务">
        <button aria-pressed={intent==='topics'} onClick={chooseTopics}><Sparkles size={15}/>做一批新选题</button>
        <button aria-pressed={intent==='position'} onClick={choosePosition}><Target size={15}/>梳理账号定位</button>
        <button disabled><ChartNoAxesColumnIncreasing size={15}/>数据复盘</button><button disabled><CalendarDays size={15}/>发布排期</button>
      </section>
      <WorkComposer value={startInput} onChange={value=>{setStartInput(value);sessionStorage.setItem('opc-new-task-input',value);}} onSend={()=>void free.send(startInput,skillId)} disabled={free.busy} label="新任务内容" placeholder="问一个问题，或描述你想做的事…" skillId={skillId} onSkillChange={setSkillId} note="直接发送即可开始对话，也可以添加资料或选择技能。"/>
      {free.error&&<p role="alert">{free.error}</p>}
      {showSource&&intent==='topics'&&<section className={styles.selection} aria-label="选择任务来源"><h2>选择账号的定位策略</h2><p>查看账号与来源后进入对应选题对话；此步不会自动采用选题或生成内容。</p>{topicAccounts.filter(a=>!sourceAccount||a.projectId===sourceAccount).map(a=><Link key={a.projectId} href={'/positioning/'+a.strategyDraftId+'/topics'} onClick={()=>{if(startInput.trim())localStorage.setItem('opc-topic-input:'+a.strategyDraftId,startInput);}}>{a.platform} · {a.account}<small>{a.businessName}{a.strategyState==='published'?' · 定位已确认':' · 定位修订中；可继续已绑定工作'}</small></Link>)}{!topicAccounts.length&&<p>还没有可用于选题的已确认策略账号。请先梳理定位。</p>}</section>}
      {!showStart&&<section className={styles.discovery}><div className={styles.discoveryHead}><div className={styles.recommendTabs}>{([['all','为你推荐'],['strategy','策略'],['writing','写作'],['operations','运营']] as const).map(([id,label])=><button key={id} aria-pressed={recommendation===id} onClick={()=>setRecommendation(id)}>{label}</button>)}</div><Link href="/workbench/marketplace">浏览全部 →</Link></div><div className={styles.discoverGrid}>
        {(recommendation==='all'||recommendation==='strategy')&&<><button onClick={chooseTopics}><span className={`${styles.moduleVisual} ${styles.artTopics}`}><span className={styles.big}>让好想法<br/>接着发生。</span><span className={styles.mini}>IDEAS, INTO STORIES.</span></span><strong>做一批新选题</strong><small>选定规划，找到值得写的方向</small></button><button onClick={choosePosition}><span className={`${styles.moduleVisual} ${styles.artPosition}`}><span className={styles.targetRings}/><b>找到<br/>你的坐标</b></span><strong>找到你的内容定位</strong><small>定位分析，明确受众与价值</small></button></>}
        {(recommendation==='all'||recommendation==='writing')&&<><button onClick={()=>{setIntent('content');setShowSource(true);}}><span className={`${styles.moduleVisual} ${styles.artDraft}`}><span className={styles.big}>从一句，<br/>到一篇。</span><span className={styles.lines}><i/><i/><i/></span></span><strong>从选题写到成稿</strong><small>内容创作，把思路写清楚</small></button><Link href="/workbench/marketplace"><span className={`${styles.moduleVisual} ${styles.artRewrite}`}><span className={styles.wordPaper}><b>长文</b><small>ORIGINAL</small></span><span>→</span><span className={styles.wordPaper}><b>短句</b><small>RECRAFTED</small></span></span><strong>换个平台，继续表达</strong><small>跨平台改编，保留内容的核心</small></Link><Link href="/workbench/marketplace"><span className={`${styles.moduleVisual} ${styles.artTitle}`}><span className={styles.big}>值得<br/>被看见。</span><span className={styles.underline}/></span><strong>推敲一个好标题</strong><small>内容创作，标题讨论快捷起点</small></Link><Link href="/workbench/marketplace"><span className={`${styles.moduleVisual} ${styles.artOpening}`}><span className={styles.quote}>“</span><b>从一个真实<br/>的瞬间开始。</b></span><strong>让开头更具体</strong><small>内容创作，开头修改快捷起点</small></Link></>}
        {(recommendation==='all'||recommendation==='operations')&&<><button disabled aria-label="发布排期，待接入"><span className={`${styles.moduleVisual} ${styles.artSchedule}`}><span className={styles.calendarArt}>WEEK<span className={styles.week}>{Array.from({length:12},(_,index)=><i key={index}/>)}</span></span><b>有序<br/>发生</b></span><strong>发布排期</strong><small>待接入，安排内容节奏</small></button><button disabled aria-label="数据复盘，待接入"><span className={`${styles.moduleVisual} ${styles.artReview}`}><span className={styles.bars}><i/><i/><i/><i/></span><b>回看，<br/>再向前。</b></span><strong>数据复盘</strong><small>待接入，从实际表现出发</small></button></>}
      </div></section>}
      {showSource&&intent==='content'&&<section className={styles.selection} aria-label="选择任务来源"><h2>选择已有内容工作</h2><p>只进入你选择的原工作；浏览列表不会生成或保存稿件。</p>{accounts.flatMap(a=>a.items.map(item=><Link key={item.workItemId} href={'/runtime?session='+item.sessionId}>{item.title}<small>{a.platform} · {a.account}</small></Link>))}{!accounts.some(a=>a.items.length)&&<p>当前没有已采用的内容工作。先在选题对话中明确采用一条选题。</p>}</section>}
      <p role="status" className={styles.mode}>运行环境和模型模式请以进入具体工作后的提示为准。</p>
      {(catalog.error || list.error) && (
        <p role="alert">当前环境未开放，或登录已失效。请登录后重试。</p>
      )}
      {pendingStart&&!start.isPending&&<section className={styles.selection} aria-label="待恢复的开始请求"><p>上次开始定位的结果尚未确认。先恢复同一请求，避免把草稿绑定到另一个业务。</p><Button onClick={()=>runStart(pendingStart)}>恢复上次开始请求</Button></section>}
      {methodDialog&&<div className={styles.modalScrim} role="presentation"><section className={styles.methodDialog} role="dialog" aria-modal="true" aria-label="梳理账号定位"><header><h2>梳理账号定位</h2><button autoFocus aria-label="关闭窗口" onClick={()=>setMethodDialog(false)}><X size={17}/></button></header><p>开始新账号的定位分析，或选择一份已有定位继续修改。</p><div className={styles.methodActions}><button onClick={()=>{setMethodDialog(false);setShowStart(true);}}>从头分析新定位</button><button onClick={()=>{setMethodDialog(false);router.push('/library');}}>整理另一份已有定位</button></div></section></div>}
      {showStart && <div className={styles.modalScrim} role="presentation"><section className={styles.startForm} role="dialog" aria-modal="true" aria-label="准备定位任务">
        <div className={styles.formHead}><div><h2>从头分析新定位</h2><p>填写产品、服务或品牌名称，开始新账号的定位分析。</p></div><button autoFocus aria-label="关闭窗口" onClick={()=>setShowStart(false)}><X size={17}/></button></div>
        <label className="block">产品、服务或品牌名称 <input placeholder="例如：摄影课程、我的咨询服务" aria-label="业务名称" value={businessName} maxLength={120} onChange={(e)=>setBusinessName(e.target.value)} className="ml-2 rounded border bg-[var(--bg-secondary)] p-2" /></label>
        <div className={styles.methodActions}>
          <Button
            disabled={!catalog.data?.length||start.isPending||Boolean(pendingStart)||!businessName.trim()}
            onClick={()=>void begin()}
          >
            {start.isPending?'正在准备…':'开始 Agent 引导'}
          </Button>
        </div>
        {!catalog.isLoading && !catalog.data?.length && (
          <p>当前没有可用的已发布定位方法。</p>
        )}
      </section></div>}
      {error && <p role="alert">{error}</p>}
    </div></main></WorkspaceFrame>
  );
}
