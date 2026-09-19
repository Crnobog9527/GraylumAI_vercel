"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
export default function PositioningHome() {
  const catalog = trpc.opc.catalog.useQuery(),
    list = trpc.opc.list.useQuery(),
    start = trpc.opc.start.useMutation();
  const [choice, setChoice] = useState(""),
    [error, setError] = useState("");
  async function begin(mode: "mentor" | "manual") {
    setError("");
    const registration = choice || catalog.data?.[0]?.id;
    if (!registration) return;
    const key = "opc-start:" + registration + ":" + mode;
    const requestId = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, requestId);
    try {
      const d = await start.mutateAsync({ requestId, registration, mode });
      sessionStorage.removeItem(key);
      location.href = "/positioning/" + d.draftId;
    } catch {
      setError("未能建立定位草稿，重试会恢复同一次开始请求。");
    }
  }
  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 text-[var(--text-primary)]">
      <header>
        <h1 className="text-3xl font-semibold">开始经营你的账号</h1>
        <p className="mt-3 text-[var(--text-secondary)]">
          先完成定位，再确认第一周计划。确认后，每个选题都有独立的工作记录。
        </p>
      </header>
      <p role="status">本地隔离体验 · 真实研究尚未开放，AI 使用模拟回复。</p>
      {(catalog.error || list.error) && (
        <p role="alert">当前环境未开放，或登录已失效。请登录后重试。</p>
      )}
      <section className="space-y-4 rounded-xl border border-[var(--border-primary)] p-5">
        <h2 className="text-xl">新建定位</h2>
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
        <div className="flex gap-3">
          <Button
            disabled={!catalog.data?.length || start.isPending}
            onClick={() => begin("mentor")}
          >
            导师引导
          </Button>
          <Button
            variant="outline"
            disabled={!catalog.data?.length || start.isPending}
            onClick={() => begin("manual")}
          >
            我已有明确定位
          </Button>
        </div>
        {!catalog.isLoading && !catalog.data?.length && (
          <p>当前没有可用的已发布定位方法。</p>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl">继续已有定位</h2>
        {list.data?.drafts?.map((d: { draftId: string; mode: string }) => (
          <div key={d.draftId}>
            <Link className="underline" href={"/positioning/" + d.draftId}>
              继续{d.mode === "manual" ? "手动" : "导师"}定位
            </Link>
          </div>
        ))}
        {list.data?.drafts?.length === 0 && <p>尚无定位草稿。</p>}
      </section>
      <section className="space-y-4">
        <h2 className="text-xl">账号与选题</h2>
        {list.data?.accounts?.map(
          (a: {
            projectId: string;
            platform: string;
            account: string;
            revision: number;
            profile: Record<
              string,
              { label: string; value: string; status: string }
            > | null;
            items: Array<{
              workItemId: string;
              sessionId: string;
              title: string;
              day: string;
            }>;
          }) => (
            <article
              key={a.projectId}
              className="rounded-xl border border-[var(--border-primary)] p-4"
            >
              <h3>
                {a.platform} · {a.account}
              </h3>
              <details>
                <summary>当前经营资料 · 第 {a.revision} 版</summary>
                {a.profile ? (
                  Object.entries(a.profile).map(([key, f]) => (
                    <p key={key} className="mt-2">
                      {f.label}：{f.value}
                      {f.status === "deferred" ? "（已明确延期）" : ""}
                    </p>
                  ))
                ) : (
                  <p>来源暂不可用。</p>
                )}
              </details>
              {a.items.map((i) => (
                <div className="mt-3" key={i.workItemId}>
                  <Link
                    className="underline"
                    href={"/runtime?session=" + i.sessionId}
                  >
                    {i.day} · {i.title}
                  </Link>
                </div>
              ))}
            </article>
          ),
        )}
      </section>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
