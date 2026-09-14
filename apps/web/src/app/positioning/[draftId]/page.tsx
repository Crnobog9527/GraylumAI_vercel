"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useEffect, useState } from "react";
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
    const raw = sessionStorage.getItem("opc-edit:" + draftId);
    if (raw) {
      try {
        const local = JSON.parse(raw);
        setEdits(local.edits ?? {});
        setInfoEdits(local.infoEdits ?? {});
        setPlanCandidate(local.planCandidate ?? null);
        if (local.dirtyPlan) {
          setItems(local.items);
          setDirtyPlan(true);
        }
      } catch {
        /* malformed local buffer is ignored */
      }
    }
  }, [draftId]);
  useEffect(() => {
    sessionStorage.setItem(
      "opc-edit:" + draftId,
      JSON.stringify({ edits, items, dirtyPlan, infoEdits, planCandidate }),
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
  }, [draftId, edits, items, dirtyPlan, infoEdits, planCandidate]);
  useEffect(() => {
    if (!dirtyPlan && latest?.body) setItems(latest.body);
  }, [latest?.planId, dirtyPlan]);
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
      if (hasUnsavedInformation) throw new Error("save information first");
      const key = "opc-step:" + draftId + ":" + step.id;
      const prior = sessionStorage.getItem(key);
      const fixed = prior
        ? JSON.parse(prior)
        : {
            draftId,
            stepId: step.id,
            requestId: crypto.randomUUID(),
            input:
              edits[step.id] ??
              snap.steps[step.id].body ??
              "请根据当前步骤指导我补充必要信息。",
          };
      if (!fixed.input.trim())
        fixed.input = "请根据当前步骤指导我补充必要信息。";
      sessionStorage.setItem(key, JSON.stringify(fixed));
      const admitted = await prepareStep.mutateAsync(fixed);
      await execute.mutateAsync({ executionId: admitted.executionId });
      if (
        d.information[step.id].schema
          .filter((f: { required: boolean }) => f.required)
          .every((f: { id: string }) =>
            ["confirmed", "deferred"].includes(
              d.information[step.id].values?.[f.id]?.status,
            ),
          )
      )
        await saveResult.mutateAsync({
          draftId,
          executionId: admitted.executionId,
          stepId: step.id,
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
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 text-[var(--text-primary)]">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">定位与第一周计划</h1>
          <p>
            本地隔离体验 · AI 使用固定模拟回复，仅验证流程；真实研究尚未开放。
          </p>
        </div>
        <Link href="/positioning" className="underline">
          账号与定位列表
        </Link>
      </header>
      <div className="flex flex-wrap gap-3">
        <span>导师对话与成果保存在当前定位中</span>
        <Button variant="outline" onClick={() => read.refetch()}>
          重新读取状态
        </Button>
      </div>
      <p>每一步先保存工作稿，再确认。手动填写和导师引导使用同一份定位成果。</p>
      {hasUnsavedInformation && (
        <p role="status">
          有未保存的信息，请先保存并重新确认受影响步骤，再发布定位或采用计划。
        </p>
      )}
      <section className="grid gap-4 md:grid-cols-2">
        {snap.workflow.steps.map((step: Step, index: number) => {
          const s = snap.steps[step.id];
          return (
            <article
              key={step.id}
              className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"
            >
              <h2 className="text-lg">
                {index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}
              </h2>
              <div className="space-y-2">
                {d.information[step.id].schema.map(
                  (field: { id: string; title: string; required: boolean }) => {
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
                            updateInfo({ value: e.target.value })
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
                  variant="outline"
                  disabled={
                    busy || hasUnsavedInformation || snap.state !== "draft"
                  }
                  onClick={() => ask(step)}
                >
                  请导师帮助这一步
                </Button>
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
            </article>
          );
        })}
      </section>
      <section aria-label="导师记录" className="space-y-3">
        {history.data?.executions.map(
          (e: {
            executionId: string;
            input?: string | null;
            body: string | null;
            primaryBody: string | null;
            state: string;
          }) => (
            <article key={e.executionId} className="rounded-xl border p-3">
              <p className="whitespace-pre-wrap">{e.input}</p>
              <p className="whitespace-pre-wrap">
                {e.body ?? e.primaryBody ?? "等待原任务恢复"}
              </p>
              {e.state !== "completed" && e.state !== "cancelled" && (
                <Button
                  onClick={() =>
                    run(() =>
                      execute.mutateAsync({ executionId: e.executionId }),
                    )
                  }
                >
                  恢复原导师任务
                </Button>
              )}
            </article>
          ),
        )}
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
