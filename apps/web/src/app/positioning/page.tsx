"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase";
import { WorkspaceFrame } from "@/components/opc/workspace-frame";
import styles from './start-work.module.css';
type StartOperation={actorId:string;requestId:string;registration:string;mode:"mentor"|"manual";businessId:string|null;businessName?:string};
type StartAccount={projectId:string;platform:string;account:string;businessName:string;strategyDraftId?:string|null;items:Array<{workItemId:string;sessionId:string;title:string}>};
const startOperationKey="opc-start-operation";
export default function PositioningHome() {
  const catalog = trpc.opc.catalog.useQuery(),
    list = trpc.opc.list.useQuery(),
    library = trpc.opc.library.useQuery({ search: "", from: null, to: null }),
    start = trpc.opc.start.useMutation();
  const [choice, setChoice] = useState(""),
    [businessId, setBusinessId] = useState(""),
    [businessName, setBusinessName] = useState(""),
    [showStart,setShowStart]=useState(false),
    [intent,setIntent]=useState<'topics'|'content'|''>(''),
    [startInput,setStartInput]=useState(''),
    [error, setError] = useState(""),
    [actorId,setActorId]=useState(""),
    [pendingStart,setPendingStart]=useState<StartOperation|null>(null);
  useEffect(()=>{const client=createClient();let alive=true;void client.auth.getUser().then(({data})=>{if(alive)setActorId(data.user?.id??"");});const {data:{subscription}}=client.auth.onAuthStateChange((_event,session)=>{if(alive)setActorId(session?.user.id??"");});return()=>{alive=false;subscription.unsubscribe();};},[]);
  useEffect(()=>{if(new URL(location.href).searchParams.has('new'))setShowStart(true);},[]);
  useEffect(()=>{setStartInput(sessionStorage.getItem('opc-new-task-input')??'');},[]);
  useEffect(()=>{setPendingStart(null);if(!actorId)return;const legacy=sessionStorage.getItem(startOperationKey);if(legacy){sessionStorage.setItem(startOperationKey+":legacy:"+Date.now(),legacy);sessionStorage.removeItem(startOperationKey);}const key=startOperationKey+":"+actorId,raw=sessionStorage.getItem(key);if(!raw)return;try{const op:StartOperation=JSON.parse(raw);if(op.actorId===actorId)setPendingStart(op);}catch{sessionStorage.removeItem(key);}},[actorId]);
  async function runStart(op:StartOperation){
    if(!actorId||op.actorId!==actorId){setError("登录账号已变化，请切回原账号恢复该请求。");return;}
    const key=startOperationKey+":"+actorId;
    setError("");sessionStorage.setItem(key,JSON.stringify(op));setPendingStart(op);
    try {
      const {actorId:_,...request}=op;void _;const d=await start.mutateAsync(request);
      sessionStorage.removeItem(key);setPendingStart(null);location.href="/positioning/"+d.draftId;
    } catch { setError("未能建立定位草稿。完整的原开始请求已保留，请恢复该请求。"); }
  }
  async function begin(mode: "mentor" | "manual") {
    if(pendingStart){setError("请先恢复上次开始请求；恢复完成后再选择其他业务。");return;}
    const registration = choice || catalog.data?.[0]?.id;
    if (!registration) return;
    if(!actorId)return;
    await runStart({actorId,requestId:crypto.randomUUID(),registration,mode,businessId:businessId||null,...(!businessId?{businessName:businessName.trim()}: {})});
  }
  const accounts:StartAccount[]=(library.data?.businesses??[]).flatMap((business:{name:string;accounts:Array<Omit<StartAccount,'businessName'>>})=>business.accounts.map(account=>({...account,businessName:business.name})));
  return (
    <WorkspaceFrame area="start"><main className={styles.page}><div className={styles.content}>
      <header className={styles.hero}><p>我的增长工作</p><h1>今天，想推进什么？</h1></header>
      <section className={styles.actions} aria-label="选择新任务">
        <button aria-pressed={intent==='topics'} onClick={()=>{setIntent('topics');setShowStart(false);if(!startInput.trim()){const value='请基于当前账号定位，帮我策划下一批选题。';setStartInput(value);sessionStorage.setItem('opc-new-task-input',value);}}}>✧ 做一批新选题</button>
        <button aria-pressed={showStart} onClick={()=>{setIntent('');setShowStart(true);if(!startInput.trim()){const value='我想梳理一个账号的定位，请从需要确认的问题开始。';setStartInput(value);sessionStorage.setItem('opc-new-task-input',value);}}}>◎ 梳理账号定位</button>
        <button disabled>▥ 数据复盘 · 待接入</button><button disabled>▣ 发布排期 · 待接入</button>
      </section>
      <div className={styles.composer}><textarea aria-label="新任务内容" placeholder="描述你想做的事，或从一个选题开始…" value={startInput} onChange={event=>{setStartInput(event.target.value);sessionStorage.setItem('opc-new-task-input',event.target.value);}}/><div className={styles.composerFoot}><span>{intent==='topics'?'先选择已确认策略的账号':showStart?'先选择定位路径':'先选择功能与来源'}</span><button type="button" aria-label="继续选择任务来源" disabled={!startInput.trim()||(!intent&&!showStart)} onClick={()=>document.querySelector('[aria-label="选择任务来源"]')?.scrollIntoView({behavior:'smooth',block:'nearest'})}>↑</button></div></div>
      <p className={styles.note}>选择功能与来源后才开始新任务；原工作的输入、成果和归属保持不变。</p>
      {intent==='topics'&&<section className={styles.selection} aria-label="选择任务来源"><h2>选择账号的当前定位策略</h2><p>查看账号与来源后进入对应选题对话；此步不会自动采用选题或生成内容。</p>{accounts.filter(a=>a.strategyDraftId).map(a=><Link key={a.projectId} href={'/positioning/'+a.strategyDraftId+'/topics'} onClick={()=>{if(startInput.trim())localStorage.setItem('opc-topic-input:'+a.strategyDraftId,startInput);}}>{a.platform} · {a.account}<small>{a.businessName}</small></Link>)}{!accounts.some(a=>a.strategyDraftId)&&<p>还没有可用于选题的已确认策略账号。请先梳理定位。</p>}</section>}
      {!intent&&!showStart&&<section className={styles.discovery}><div><h2>为你推荐</h2><Link href="/workbench/marketplace">浏览全部 →</Link></div><div className={styles.discoverGrid}><button onClick={()=>setIntent('topics')}>让好想法<br/>接着发生。<small>做一批新选题</small></button><button onClick={()=>setShowStart(true)}>找到<br/>你的坐标<small>梳理账号定位</small></button><button onClick={()=>setIntent('content')}>从一句，<br/>到一篇。<small>从选题写到成稿</small></button><Link href="/workbench/marketplace">换个平台，继续表达<small>查看更多功能</small></Link></div></section>}
      {intent==='content'&&<section className={styles.selection} aria-label="选择任务来源"><h2>选择已有内容工作</h2><p>只进入你选择的原工作；浏览列表不会生成或保存稿件。</p>{accounts.flatMap(a=>a.items.map(item=><Link key={item.workItemId} href={'/runtime?session='+item.sessionId}>{item.title}<small>{a.platform} · {a.account}</small></Link>))}{!accounts.some(a=>a.items.length)&&<p>当前没有已采用的内容工作。先在选题对话中明确采用一条选题。</p>}</section>}
      <p role="status" className={styles.mode}>运行环境和模型模式请以进入具体工作后的提示为准。</p>
      {(catalog.error || list.error) && (
        <p role="alert">当前环境未开放，或登录已失效。请登录后重试。</p>
      )}
      {pendingStart&&!start.isPending&&<section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-primary)] p-4" aria-label="待恢复的开始请求"><p>上次开始定位的结果尚未确认。先恢复同一请求，避免把草稿绑定到另一个业务。</p><Button onClick={()=>runStart(pendingStart)}>恢复上次开始请求</Button></section>}
      {Boolean(list.data?.drafts?.length) && <Button variant="outline" onClick={()=>setShowStart(value=>!value)}>{showStart?'收起新定位入口':'为另一个产品、服务或品牌开始定位'}</Button>}
      {(showStart || (!list.data?.drafts?.length&&!intent)) && <section className={styles.startForm} aria-label="选择任务来源">
        <h2 className="text-xl">这次要为哪个产品、服务或品牌定位？</h2>
        <label>
          定位方法{" "}
          <select
            aria-label="定位方法"
            value={choice || catalog.data?.[0]?.id || ""}
            onChange={(e) => setChoice(e.target.value)}
            className="rounded border bg-[var(--bg-secondary)] p-2"
          >
            {catalog.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.workflow.steps.length} 步
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          业务
          <select aria-label="所属业务" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="ml-2 rounded border bg-[var(--bg-secondary)] p-2">
            <option value="">另一个产品、服务或品牌</option>
            {library.data?.businesses?.map((business: { businessId: string; name: string }) => (
              <option key={business.businessId} value={business.businessId}>{business.name}</option>
            ))}
          </select>
        </label>
        {!businessId && <label className="block">产品、服务或品牌名称 <input placeholder="例如：摄影课程、我的咨询服务" aria-label="业务名称" value={businessName} maxLength={120} onChange={(e) => setBusinessName(e.target.value)} className="ml-2 rounded border bg-[var(--bg-secondary)] p-2" /></label>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Button
            disabled={!catalog.data?.length || start.isPending || Boolean(pendingStart) || (!businessId && !businessName.trim())}
            onClick={() => begin("mentor")}
          >
            我从零开始 · Agent 引导
          </Button>
          <Button
            variant="outline"
            disabled={!catalog.data?.length || start.isPending || Boolean(pendingStart) || (!businessId && !businessName.trim())}
            onClick={() => begin("manual")}
          >
            我已有定位 · 结构化录入
          </Button>
        </div>
        {!catalog.isLoading && !catalog.data?.length && (
          <p>当前没有可用的已发布定位方法。</p>
        )}
      </section>}
      <section className={styles.resume}>
        <h2>继续已有定位</h2>
        {list.data?.drafts?.map((d: { draftId: string; mode: string; businessName?:string;createdAt?:string;currentVersion?:number;state?:string }) => (
          <div key={d.draftId} className={styles.resumeItem}>
            <Link className="underline" href={"/positioning/" + d.draftId}>
              {d.businessName ?? "未命名业务"} · 继续定位
            </Link>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{d.state==='published' ? `正式定位第 ${d.currentVersion} 版 · 查看或继续选题` : d.currentVersion ? `正在修订 · 原正式第 ${d.currentVersion} 版保留` : '定位进行中 · 接着上次继续'}{d.createdAt ? ' · '+new Date(d.createdAt).toLocaleString('zh-CN') : ''}</p>
          </div>
        ))}
        {list.data?.drafts?.length === 0 && <p>尚无定位草稿。</p>}
      </section>
      <section className={styles.libraryLink}>
        <div><h2 className="text-xl">内容资料库</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">已保存的业务、账号、选题和内容版本统一在资料库查找与继续。</p></div>
        <Link className="underline" href="/library">打开内容资料库</Link>
      </section>
      {error && <p role="alert">{error}</p>}
    </div></main></WorkspaceFrame>
  );
}
