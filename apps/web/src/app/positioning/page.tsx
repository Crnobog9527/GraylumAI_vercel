"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase";
type StartOperation={actorId:string;requestId:string;registration:string;mode:"mentor"|"manual";businessId:string|null;businessName?:string};
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
    [error, setError] = useState(""),
    [actorId,setActorId]=useState(""),
    [pendingStart,setPendingStart]=useState<StartOperation|null>(null);
  useEffect(()=>{const client=createClient();let alive=true;void client.auth.getUser().then(({data})=>{if(alive)setActorId(data.user?.id??"");});const {data:{subscription}}=client.auth.onAuthStateChange((_event,session)=>{if(alive)setActorId(session?.user.id??"");});return()=>{alive=false;subscription.unsubscribe();};},[]);
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
  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 text-[var(--text-primary)]">
      <header>
        <h1 className="text-3xl font-semibold">开始经营你的账号</h1>
        <p className="mt-3 text-[var(--text-secondary)]">
          选择适合你的入口。Agent 会保存过程，完成正式定位后再询问是否开始选题。
        </p>
      </header>
      <p role="status">运行环境和模型模式请以进入草稿或工作会话后的提示为准。</p>
      {(catalog.error || list.error) && (
        <p role="alert">当前环境未开放，或登录已失效。请登录后重试。</p>
      )}
      {pendingStart&&!start.isPending&&<section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-primary)] p-4" aria-label="待恢复的开始请求"><p>上次开始定位的结果尚未确认。先恢复同一请求，避免把草稿绑定到另一个业务。</p><Button onClick={()=>runStart(pendingStart)}>恢复上次开始请求</Button></section>}
      {Boolean(list.data?.drafts?.length) && <Button variant="outline" onClick={()=>setShowStart(value=>!value)}>{showStart?'收起新定位入口':'为另一个产品、服务或品牌开始定位'}</Button>}
      {(showStart || list.data?.drafts?.length === 0) && <section className="space-y-4 rounded-xl border border-[var(--border-primary)] p-5">
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
      <section className="space-y-3">
        <h2 className="text-xl">继续已有定位</h2>
        {list.data?.drafts?.map((d: { draftId: string; mode: string; businessName?:string;createdAt?:string;currentVersion?:number;state?:string }) => (
          <div key={d.draftId} className="rounded-xl border border-[var(--border-primary)] p-4">
            <Link className="underline" href={"/positioning/" + d.draftId}>
              {d.businessName ?? "未命名业务"} · 继续定位
            </Link>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{d.state==='published' ? `正式定位第 ${d.currentVersion} 版 · 查看或继续选题` : d.currentVersion ? `正在修订 · 原正式第 ${d.currentVersion} 版保留` : '定位进行中 · 接着上次继续'}{d.createdAt ? ' · '+new Date(d.createdAt).toLocaleString('zh-CN') : ''}</p>
          </div>
        ))}
        {list.data?.drafts?.length === 0 && <p>尚无定位草稿。</p>}
      </section>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--border-primary)] p-5">
        <div><h2 className="text-xl">内容资料库</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">已保存的业务、账号、选题和内容版本统一在资料库查找与继续。</p></div>
        <Link className="underline" href="/library">打开内容资料库</Link>
      </section>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
