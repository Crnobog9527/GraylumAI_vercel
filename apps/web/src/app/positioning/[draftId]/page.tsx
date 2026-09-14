"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
type Step = { id: string; title: string };
type Information = {
  status: "unknown" | "unclear" | "provisional" | "confirmed" | "deferred";
  nature: "fact" | "decision" | "hypothesis" | "unknown";
  value: string;
};
type Item = {
  id: string;
  platform: string;
  account: string;
  title: string;
  brief: string;
  day: string;
};
export default function PositioningDraft({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = use(params);
  const utils = trpc.useUtils();
  const read = trpc.opc.read.useQuery({ draftId });
  const list = trpc.opc.list.useQuery();
  const prepareStep = trpc.opc.prepareStep.useMutation(),
    execute = trpc.runtime.execute.useMutation(),
    saveResult = trpc.opc.saveResult.useMutation();
  const information = trpc.opc.information.useMutation();
  const [infoEdits, setInfoEdits] = useState<
    Record<string, Record<string, Information>>
  >({});
  const revise = trpc.opc.revise.useMutation();
  const change = trpc.workbench.execute.useMutation(),
    savePlan = trpc.opc.savePlan.useMutation(),
    handoff = trpc.opc.handoff.useMutation();
  const [running, setRunning] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({}),
    [items, setItems] = useState<Item[]>([]),
    [dirtyPlan, setDirtyPlan] = useState(false),
    [planCandidate, setPlanCandidate] = useState<Item[] | null>(null),
    [error, setError] = useState("");
  const history = trpc.runtime.view.useQuery(
    { sessionId: read.data?.sessionId ?? "" },
    { enabled: Boolean(read.data?.sessionId) },
  );
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [mentorOpen, setMentorOpen] = useState<Record<string, boolean>>({});
  const chatScroll = useRef<HTMLDivElement>(null);
  const [mentorInputs, setMentorInputs] = useState<Record<string, string>>({});
  const [hydratedDraft, setHydratedDraft] = useState<string | null>(null);
  const hasUnsavedInformation = Object.keys(infoEdits).length > 0;
  const d = read.data,
    snap = d?.snapshot,
    latest = d?.plans?.[0];
  const busy =
    running ||
    revise.isPending ||
    prepareStep.isPending ||
    execute.isPending ||
    saveResult.isPending ||
    change.isPending ||
    savePlan.isPending ||
    handoff.isPending;
  useEffect(() => {
    // Hydrate before persisting: initial/StrictMode effects must not overwrite
    // a saved buffer with the render's empty initial state.
    let local: Record<string, any> = {};
    try {
      const raw = sessionStorage.getItem("opc-edit:" + draftId);
      if (raw) local = JSON.parse(raw) ?? {};
    } catch {
      /* Ignore a malformed local buffer. */
    }
    setActiveStep(
      typeof local.activeStep === "string" ? local.activeStep : null,
    );
    setMentorInputs(local.mentorInputs ?? {});
    setMentorOpen(local.mentorOpen ?? {});
    setEdits(local.edits ?? {});
    setInfoEdits(local.infoEdits ?? {});
    setPlanCandidate(
      Array.isArray(local.planCandidate) ? local.planCandidate : null,
    );
    setDirtyPlan(Boolean(local.dirtyPlan));
    setItems(local.dirtyPlan && Array.isArray(local.items) ? local.items : []);
    setHydratedDraft(draftId);
  }, [draftId]);
  useEffect(() => {
    if (hydratedDraft !== draftId) return;
    sessionStorage.setItem(
      "opc-edit:" + draftId,
      JSON.stringify({
        edits,
        items,
        dirtyPlan,
        infoEdits,
        planCandidate,
        activeStep,
        mentorInputs,
        mentorOpen,
      }),
    );
    const warn = (e: BeforeUnloadEvent) => {
      if (
        Object.keys(edits).length ||
        Object.keys(infoEdits).length ||
        dirtyPlan
      )
        e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    draftId,
    hydratedDraft,
    edits,
    items,
    dirtyPlan,
    infoEdits,
    planCandidate,
    activeStep,
    mentorInputs,
    mentorOpen,
  ]);
  useEffect(() => {
    if (hydratedDraft === draftId && !dirtyPlan && latest?.body)
      setItems(latest.body);
  }, [draftId, hydratedDraft, latest?.planId, dirtyPlan]);
  useEffect(() => {
    if (hydratedDraft !== draftId || activeStep || !snap) return;
    const initial =
      snap.workflow.steps.find((step: Step) => !snap.steps[step.id].valid) ??
      snap.workflow.steps[0];
    setActiveStep(initial.id);
  }, [draftId, hydratedDraft, activeStep, snap]);
  useEffect(() => {
    if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [activeStep, mentorOpen, history.data]);
  async function run(fn: () => Promise<unknown>) {
    setRunning(true);
    setError("");
    try {
      await fn();
      await read.refetch();
      await list.refetch();
      await history.refetch();
    } catch {
      setError(
        "操作未完成或版本已变化。编辑已保留；请重新读取状态，确认当前版本后再操作。",
      );
    } finally {
      setRunning(false);
    }
  }
  async function ask(step: Step) {
    await run(async () => {
      const key = "opc-step:" + draftId + ":" + step.id;
      const prior = sessionStorage.getItem(key);
      const fixed = prior ? JSON.parse(prior) : {
        request: {
          draftId, stepId: step.id, purpose: "mentor", requestId: crypto.randomUUID(),
          input: mentorInputs[step.id]?.trim() || "我还不确定这一步该怎么填写，请和我一起梳理。",
        },
        information: infoEdits[step.id] ? {
          draftId, stepId: step.id, requestId: crypto.randomUUID(),
          expectedVersion: snap.steps[step.id].version, values: infoEdits[step.id],
        } : null,
        editingSnapshot: JSON.stringify(infoEdits[step.id] ?? null),
      };
      sessionStorage.setItem(key, JSON.stringify(fixed));
      if (fixed.information) {
        await information.mutateAsync(fixed.information);
        setInfoEdits(old => {
          if (JSON.stringify(old[step.id] ?? null) !== fixed.editingSnapshot) return old;
          const next = {...old}; delete next[step.id]; return next;
        });
      }
      // Preserve pending requests from the previous UI without changing identity.
      const request = fixed.request ?? fixed;
      const admitted = await prepareStep.mutateAsync(request);
      await execute.mutateAsync({ executionId: admitted.executionId });
      sessionStorage.removeItem(key);
      setMentorInputs(old => old[step.id]?.trim() === request.input.trim() ? {...old, [step.id]: ""} : old);
    });
  }
  async function organize(step: Step) {
    const key = "opc-organize:" + draftId + ":" + step.id;
    const prior = sessionStorage.getItem(key);
    let fixed;
    if (prior) {
      try {
        fixed = JSON.parse(prior);
      } catch {
        setError("原整理请求记录无法读取，已保留，请勿重新发起整理。");
        return;
      }
    } else {
      const schema = d.information[step.id].schema;
      const values = Object.fromEntries(
        schema.map((field: { id: string }) => {
          const value: Information = infoEdits[step.id]?.[field.id] ??
            d.information[step.id].values?.[field.id] ?? {
              status: "unknown",
              nature: "unknown",
              value: "",
            };
          // This button explicitly confirms text supplied by the user. It never
          // confirms a model inference or overrides an explicit uncertainty.
          return [
            field.id,
            {
              ...value,
              status:
                value.status === "unknown" && value.value.trim()
                  ? "confirmed"
                  : value.status,
            },
          ];
        }),
      );
      const missing = schema.filter(
        (field: { id: string; required: boolean }) =>
          field.required &&
          !["confirmed", "deferred"].includes(values[field.id].status),
      );
      if (missing.length) {
        setError(
          "请补充或明确延期这些必需信息：" +
            missing.map((field: { title: string }) => field.title).join("、"),
        );
        return;
      }
      if (schema.some((field: { id: string }) =>
        ["confirmed", "deferred"].includes(values[field.id].status) &&
        !values[field.id].value.trim())) {
        setError("已确认的信息需要填写内容；延期的信息请注明原因。");
        return;
      }
      if (new TextEncoder().encode(JSON.stringify(values)).length > 12000) {
        setError("本步信息过长，请精简后再整理。");
        return;
      }
      fixed = {
        information: {
          draftId,
          stepId: step.id,
          requestId: crypto.randomUUID(),
          expectedVersion: snap.steps[step.id].version,
          values,
        },
        request: {
          draftId,
          stepId: step.id,
          requestId: crypto.randomUUID(),
          organizeAfter: true,
          input:
            "请基于本步已确认或明确延期的信息形成步骤成果，再由整理模型汇总；保留局限，不补造事实。",
        },
        editingSnapshot: JSON.stringify(infoEdits[step.id] ?? null),
      };
      sessionStorage.setItem(key, JSON.stringify(fixed));
    }
    await run(async () => {
      await information.mutateAsync(fixed.information);
      setInfoEdits((old) => {
        if (JSON.stringify(old[step.id] ?? null) !== fixed.editingSnapshot)
          return old;
        const next = { ...old };
        delete next[step.id];
        return next;
      });
      const admitted = await prepareStep.mutateAsync(fixed.request);
      await execute.mutateAsync({ executionId: admitted.executionId });
      await saveResult.mutateAsync({
        draftId,
        stepId: step.id,
        executionId: admitted.executionId,
        requestId: admitted.executionId,
      });
      sessionStorage.removeItem(key);
    });
  }
  async function save(step: Step) {
    await run(async () => {
      await change.mutateAsync({
        action: "save",
        projectId: d.projectId,
        roundId: d.roundId,
        requestId: crypto.randomUUID(),
        stepId: step.id,
        expectedVersion: snap.steps[step.id].version,
        body: edits[step.id],
        evidenceIds: snap.steps[step.id].evidenceIds,
      });
      setEdits((e) => {
        const next = { ...e };
        delete next[step.id];
        return next;
      });
    });
  }
  function update(index: number, key: keyof Item, value: string) {
    setItems((old) =>
      old.map((item, n) => (n === index ? { ...item, [key]: value } : item)),
    );
    setDirtyPlan(true);
  }
  async function generatePlan() {
    await run(async () => {
      if (hasUnsavedInformation) throw new Error("save information first");
      const accountInput = items.length
        ? JSON.stringify(
            items.map((i) => ({
              platform: i.platform,
              account: i.account,
              day: i.day,
            })),
          )
        : "";
      if (!accountInput) throw new Error("add concrete accounts first");
      const key = "opc-plan-generation:" + draftId;
      const old = sessionStorage.getItem(key);
      const request = old
        ? JSON.parse(old)
        : {
            draftId,
            requestId: crypto.randomUUID(),
            purpose: "plan" as const,
            stepId: snap.workflow.steps.at(-1).id,
            input: accountInput,
          };
      sessionStorage.setItem(key, JSON.stringify(request));
      const prepared = await prepareStep.mutateAsync(request);
      await execute.mutateAsync({ executionId: prepared.executionId });
      const candidate = await utils.opc.planResult.fetch({
        draftId,
        executionId: prepared.executionId,
      });
      setPlanCandidate(candidate.body);
      sessionStorage.removeItem(key);
    });
  }
  async function confirmPlan() {
    await run(async () => {
      if (
        !latest ||
        dirtyPlan ||
        Object.keys(edits).length ||
        hasUnsavedInformation
      )
        throw new Error("save edits first");
      const accounts = Array.from(
        new Map(
          items.map((i) => [
            i.platform + ":" + i.account,
            {
              platform: i.platform,
              account: i.account,
              expectedRevision:
                list.data?.accounts?.find(
                  (a: {
                    platform: string;
                    account: string;
                    revision: number;
                  }) => a.platform === i.platform && a.account === i.account,
                )?.revision ?? null,
            },
          ]),
        ).values(),
      );
      const payload = { draftId, planId: latest.planId, accounts };
      const key = "opc-confirm:" + draftId;
      const previous = sessionStorage.getItem(key);
      const fixed = previous
        ? JSON.parse(previous)
        : { ...payload, requestId: crypto.randomUUID() };
      if (
        fixed.draftId !== payload.draftId ||
        fixed.planId !== payload.planId ||
        JSON.stringify(
          fixed.accounts
            .map((a: { platform: string; account: string }) => [
              a.platform,
              a.account,
            ])
            .sort(),
        ) !==
          JSON.stringify(
            payload.accounts.map((a) => [a.platform, a.account]).sort(),
          )
      )
        throw new Error("confirmation pending");
      sessionStorage.setItem(key, JSON.stringify(fixed));
      await handoff.mutateAsync(fixed);
      sessionStorage.removeItem(key);
    });
  }
  if (read.isLoading) return <main className="p-6">正在恢复定位…</main>;
  if (read.error || !d)
    return (
      <main className="p-6" role="alert">
        无法读取这份定位，请检查登录和访问权限。
        <Link href="/positioning">返回定位列表</Link>
      </main>
    );
  const steps: Step[] = snap.workflow.steps;
  const firstPending = steps.findIndex((step) => !snap.steps[step.id].valid);
  const selectedStep =
    steps.find((step) => step.id === activeStep) ??
    steps[Math.max(0, firstPending)];
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6 text-[var(--text-primary)]">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">定位与第一周计划</h1>
          <p className="text-xs text-[var(--text-secondary)]">隔离模拟 · 未调用真实模型或研究服务</p>
        </div>
        <Link href="/positioning" className="underline">
          账号与定位列表
        </Link>
      </header>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => read.refetch()}>
          重新读取状态
        </Button>
      </div>
      <nav aria-label="定位步骤" className="flex gap-2 overflow-x-auto pb-1">
        {steps.map((step, index) => (
          <Button
            key={step.id}
            variant={selectedStep.id === step.id ? "default" : "outline"}
            aria-current={selectedStep.id === step.id ? "step" : undefined}
            disabled={
              busy ||
              (firstPending >= 0 &&
                index > firstPending &&
                !snap.steps[step.id].valid)
            }
            onClick={() => setActiveStep(step.id)}
          >
            {index + 1}. {step.title}
            {snap.steps[step.id].valid ? " · 已确认" : ""}
          </Button>
        ))}
      </nav>
      {hasUnsavedInformation && (
        <p role="status">
          有未保存的信息，请先保存并重新确认受影响步骤，再发布定位或采用计划。
        </p>
      )}
      <section aria-label="当前定位步骤" className="space-y-4">
        {snap.workflow.steps.map((step: Step, index: number) => {
          if (step.id !== selectedStep.id) return null;
          const s = snap.steps[step.id];
          return (
            <article
              key={step.id}
              className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"
            >
              <h2 className="text-lg">
                {index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}
              </h2>
              <div className={mentorOpen[step.id] ? "grid items-start gap-6 lg:grid-cols-2" : "max-w-3xl"}>
              <section aria-label="本步填写信息" className="space-y-4">
                <div className="space-y-2">
                  {d.information[step.id].schema.map(
                    (field: {
                      id: string;
                      title: string;
                      required: boolean;
                    }) => {
                      const value = infoEdits[step.id]?.[field.id] ??
                        d.information[step.id].values?.[field.id] ?? {
                          status: "unknown",
                          nature: "unknown",
                          value: "",
                        };
                      function updateInfo(patch: Partial<Information>) {
                        setInfoEdits((old) => ({
                          ...old,
                          [step.id]: {
                            ...Object.fromEntries(
                              d.information[step.id].schema.map(
                                (f: { id: string }) => [
                                  f.id,
                                  old[step.id]?.[f.id] ??
                                    d.information[step.id].values?.[f.id] ?? {
                                      status: "unknown",
                                      nature: "unknown",
                                      value: "",
                                    },
                                ],
                              ),
                            ),
                            [field.id]: { ...value, ...patch },
                          },
                        }));
                      }
                      return (
                        <label key={field.id} className="block">
                          {field.title}
                          {field.required ? "（必需）" : ""}
                          <input
                            aria-label={field.title}
                            maxLength={400}
                            className="w-full rounded border bg-transparent p-2"
                            disabled={busy || snap.state !== "draft"}
                            value={value.value}
                            onChange={(e) =>
                              updateInfo({ value: e.target.value, status: value.status === "confirmed" ? "unknown" : value.status })
                            }
                          />
                          <select
                            aria-label={field.title + " 状态"}
                            value={value.status}
                            disabled={busy || snap.state !== "draft"}
                            onChange={(e) =>
                              updateInfo({
                                status: e.target.value as Information["status"],
                              })
                            }
                          >
                            {Object.entries({
                              unknown: "未知",
                              unclear: "待澄清",
                              provisional: "暂定",
                              confirmed: "用户已确认",
                              deferred: "明确延期，接受局限",
                            }).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={field.title + " 性质"}
                            value={value.nature}
                            disabled={busy || snap.state !== "draft"}
                            onChange={(e) =>
                              updateInfo({
                                nature: e.target.value as Information["nature"],
                              })
                            }
                          >
                            {Object.entries({
                              unknown: "未知",
                              fact: "事实",
                              decision: "用户决定",
                              hypothesis: "假设",
                            }).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    },
                  )}
                  <Button
                    variant="outline"
                    disabled={
                      busy || !infoEdits[step.id] || snap.state !== "draft"
                    }
                    onClick={() =>
                      run(async () => {
                        await information.mutateAsync({
                          draftId,
                          stepId: step.id,
                          requestId: crypto.randomUUID(),
                          expectedVersion: s.version,
                          values: infoEdits[step.id],
                        });
                        setInfoEdits((old) => {
                          const next = { ...old };
                          delete next[step.id];
                          return next;
                        });
                      })
                    }
                  >
                    保存信息状态
                  </Button>
                </div>
                <Button variant="outline" aria-expanded={Boolean(mentorOpen[step.id])}
                  onClick={() => setMentorOpen(old => ({...old, [step.id]: !old[step.id]}))}>
                  请导师帮助这一步
                </Button>
                <p className="text-xs text-[var(--text-secondary)]">不确定怎么填，可以与导师多聊几轮；讨论不会自动确认答案或进入下一步。</p>
              </section>
              {mentorOpen[step.id] && (
                <aside aria-label="本步导师聊天" className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 lg:sticky lg:top-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold">和导师聊聊 · {step.title}</h3>
                    <Button variant="outline" onClick={() => setMentorOpen(old => ({...old, [step.id]: false}))}>收起聊天</Button>
                  </div>
                  <div ref={chatScroll} role="log" aria-label="本步导师消息" aria-live="polite" className="max-h-[50vh] min-h-32 space-y-3 overflow-y-auto overscroll-contain pr-2">
                    {(history.data?.executions ?? []).filter((e: {executionId: string}) =>
                      d.turns?.some((t: {executionId: string; stepId: string; kind: string}) => t.executionId === e.executionId && t.stepId === step.id && t.kind === "mentor")
                    ).map((e: {executionId: string; input: string | null; body: string | null; primaryBody: string | null; state: string}) => (
                      <div key={e.executionId} className="space-y-2">
                        <div className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3"><span className="text-xs">你</span><p className="whitespace-pre-wrap break-words">{e.input ?? "内容暂不可用"}</p></div>
                        <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3"><span className="text-xs">导师</span><p className="whitespace-pre-wrap break-words">{e.body ?? e.primaryBody ?? "等待原任务恢复"}</p></div>
                        {e.state !== "completed" && e.state !== "cancelled" && <Button variant="outline" disabled={busy} onClick={() => run(() => execute.mutateAsync({executionId:e.executionId}))}>恢复原导师任务</Button>}
                      </div>
                    ))}
                  </div>
                  <label className="block text-sm">说说你卡在哪里，或继续回答导师
                    <Textarea aria-label="给导师的回复" value={mentorInputs[step.id] ?? ""}
                      disabled={busy || snap.state !== "draft"}
                      onChange={e => setMentorInputs(old => ({...old, [step.id]:e.target.value}))}
                      placeholder="可以慢慢聊，不必一次想清楚。" maxLength={8000} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy || snap.state !== "draft" || !mentorInputs[step.id]?.trim()} onClick={() => ask(step)}>{busy ? "正在回复…" : "发送"}</Button>
                    {!mentorInputs[step.id]?.trim() && <Button variant="outline" disabled={busy || snap.state !== "draft"} onClick={() => ask(step)}>帮我开始梳理</Button>}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">对话随本步保存，可刷新后继续。当前回复为本地模拟。</p>
                </aside>
              )}
              </div>
              <section aria-label="本步成果" className="space-y-3 border-t border-[var(--border-primary)] pt-4">
                {(history.data?.executions ?? []).filter((e: {executionId:string;state:string}) =>
                  !["completed","cancelled"].includes(e.state) && d.turns?.some((t: {executionId:string;stepId:string;kind:string}) => t.executionId === e.executionId && t.stepId === step.id && t.kind !== "mentor")
                ).map((e: {executionId:string}) => <div key={e.executionId} className="text-sm">
                  本步有尚未完成的整理或计划。
                  <Button variant="outline" disabled={busy} onClick={() => run(() => execute.mutateAsync({executionId:e.executionId}))}>恢复原处理</Button>
                </div>)}
                <p className="text-sm">
                  下面的按钮会确认你填写的内容，并交给管理员配置的整理模型形成成果候选。明确标为待澄清或暂定的信息仍需核对；不会自动编造事实。
                </p>
                <Button
                  disabled={busy || snap.state !== "draft"}
                  onClick={() => organize(step)}
                >
                  确认所填信息并整理成果
                </Button>
                <p className="text-sm">
                  已有成果可以在下方手动修改；无需重新抄写表单。
                </p>
                <Textarea
                  aria-label={step.title + " 工作稿"}
                  value={edits[step.id] ?? s.body ?? ""}
                  disabled={busy || snap.state !== "draft"}
                  onChange={(e) =>
                    setEdits((old) => ({ ...old, [step.id]: e.target.value }))
                  }
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      busy || !(step.id in edits) || snap.state !== "draft"
                    }
                    onClick={() => save(step)}
                  >
                    保存工作稿
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      step.id in edits ||
                      step.id in infoEdits ||
                      snap.state !== "draft"
                    }
                    onClick={() =>
                      run(() =>
                        change.mutateAsync({
                          action: "confirm",
                          projectId: d.projectId,
                          roundId: d.roundId,
                          requestId: crypto.randomUUID(),
                          stepId: step.id,
                          expectedVersion: s.version,
                          expectedReviewVersion: s.reviewVersion,
                        }),
                      )
                    }
                  >
                    确认这一步
                  </Button>
                </div>
                {snap.candidates
                  .filter((c: { stepId: string }) => c.stepId === step.id)
                  .map((c: { id: string; body: string | null }) => (
                    <aside
                      key={c.id}
                      className="space-y-2 border-t border-[var(--border-primary)] pt-3"
                    >
                      <p className="text-sm">AI 候选 · 尚未替换工作稿</p>
                      <p className="whitespace-pre-wrap">
                        {c.body ?? "来源不可用"}
                      </p>
                      <Button
                        variant="outline"
                        disabled={
                          busy ||
                          !c.body ||
                          hasUnsavedInformation ||
                          snap.state !== "draft" ||
                          step.id in edits
                        }
                        onClick={() =>
                          run(() =>
                            change.mutateAsync({
                              action: "saveCandidate",
                              projectId: d.projectId,
                              roundId: d.roundId,
                              stepId: step.id,
                              requestId: crypto.randomUUID(),
                              expectedVersion: s.version,
                              body: c.body!,
                              candidateId: c.id,
                            }),
                          )
                        }
                      >
                        采用到工作稿
                      </Button>
                    </aside>
                  ))}
              </section>
              {s.valid && index < steps.length - 1 && (
                <Button
                  disabled={busy || hasUnsavedInformation || step.id in edits}
                  onClick={() => setActiveStep(steps[index + 1].id)}
                >
                  继续下一步
                </Button>
              )}
            </article>
          );
        })}
      </section>
      {snap.state === "published" && (
        <Button
          variant="outline"
          disabled={busy || dirtyPlan}
          onClick={() =>
            run(() =>
              revise.mutateAsync({
                draftId,
                requestId: crypto.randomUUID(),
                expectedRoundId: d.roundId,
              }),
            )
          }
        >
          修订定位，保留原版本
        </Button>
      )}
      <Button
        disabled={
          busy ||
          hasUnsavedInformation ||
          Object.keys(edits).length > 0 ||
          steps.some((step) => !snap.steps[step.id].valid) ||
          snap.state !== "draft"
        }
        onClick={() =>
          run(() =>
            change.mutateAsync({
              action: "publish",
              projectId: d.projectId,
              roundId: d.roundId,
              requestId: crypto.randomUUID(),
              expectedSteps: Object.fromEntries(
                Object.entries(
                  snap.steps as Record<
                    string,
                    { version: number; reviewVersion: number }
                  >,
                ).map(([k, v]) => [
                  k,
                  { version: v.version, reviewVersion: v.reviewVersion },
                ]),
              ),
            }),
          )
        }
      >
        确认正式定位版本
      </Button>
      {d.report?.available && (
        <section className="space-y-4">
          <h2 className="text-xl">第一周计划</h2>
          <p>可编辑账号、日期和简报。确认承接不会调用模型或产生新的费用。</p>
          {items.map((item, index) => (
            <article
              key={item.id}
              className="grid gap-3 rounded-xl border border-[var(--border-primary)] p-4 sm:grid-cols-2"
            >
              {(["platform", "account", "title", "day"] as const).map((key) => (
                <label key={key}>
                  {
                    {
                      platform: "平台",
                      account: "具体账号",
                      title: "选题",
                      day: "日期",
                    }[key]
                  }
                  <input
                    className="ml-2 rounded border bg-[var(--bg-secondary)] p-2"
                    aria-label={key + " " + index}
                    type={key === "day" ? "date" : "text"}
                    disabled={busy}
                    value={item[key]}
                    onChange={(e) => update(index, key, e.target.value)}
                  />
                </label>
              ))}
              <label>
                简报
                <Textarea
                  disabled={busy}
                  value={item.brief}
                  onChange={(e) => update(index, "brief", e.target.value)}
                />
              </label>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setItems((old) => old.filter((_, n) => n !== index));
                  setDirtyPlan(true);
                }}
              >
                删除选题
              </Button>
            </article>
          ))}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={
                busy ||
                hasUnsavedInformation ||
                !items.length ||
                items.some((i) => !i.account)
              }
              onClick={generatePlan}
            >
              按已保存账号生成计划候选
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setItems((old) => [
                  ...old,
                  {
                    id: crypto.randomUUID(),
                    platform: "x",
                    account: "",
                    title: "",
                    brief: "",
                    day: new Date().toISOString().slice(0, 10),
                  },
                ]);
                setDirtyPlan(true);
              }}
            >
              添加选题
            </Button>
            <Button
              disabled={
                busy || hasUnsavedInformation || !dirtyPlan || !items.length
              }
              onClick={() =>
                run(async () => {
                  if (hasUnsavedInformation)
                    throw new Error("save information first");
                  await savePlan.mutateAsync({
                    draftId,
                    requestId: crypto.randomUUID(),
                    expectedVersion: latest?.version ?? 0,
                    sourceVersionId: d.report.id,
                    body: items,
                  });
                  await read.refetch();
                  setDirtyPlan(false);
                })
              }
            >
              保存计划版本
            </Button>
          </div>
          {planCandidate && (
            <div className="space-y-3 rounded border border-[var(--border-primary)] p-4">
              <h3>AI 计划候选 · 尚未替换你的编辑</h3>
              {planCandidate.map((i) => (
                <p key={i.id}>
                  {i.day} · {i.platform}/{i.account} · {i.title}
                </p>
              ))}
              <Button
                disabled={busy}
                onClick={() => {
                  setItems(planCandidate);
                  setDirtyPlan(true);
                  setPlanCandidate(null);
                }}
              >
                采用候选到计划工作稿
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPlanCandidate(null)}
              >
                保留原计划
              </Button>
            </div>
          )}
          {latest && !dirtyPlan && (
            <div className="rounded-xl border border-[var(--border-primary)] p-4">
              <h3>确认采用定位与计划第 {latest.version} 版</h3>
              <p>
                将为以上具体账号创建选题；已有账号将采用当前定位，原有工作项保持原版本。
              </p>
              <Button
                disabled={
                  busy || hasUnsavedInformation || Object.keys(edits).length > 0
                }
                onClick={confirmPlan}
              >
                确认账号与计划，创建选题
              </Button>
            </div>
          )}
        </section>
      )}
      {d.handoffs?.length > 0 && (
        <section>
          <h2 className="text-xl">已承接选题</h2>
          {d.handoffs
            .flatMap(
              (h: {
                result: Array<{ workItemId: string; sessionId: string }>;
              }) => h.result,
            )
            .map((i: { workItemId: string; sessionId: string }) => (
              <div key={i.workItemId}>
                <Link
                  className="underline"
                  href={"/runtime?session=" + i.sessionId}
                >
                  进入选题工作空间
                </Link>
              </div>
            ))}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
