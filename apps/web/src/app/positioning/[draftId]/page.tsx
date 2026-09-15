"use client";
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { readMentorResponse } from "./mentor-response";
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
type ConfirmStepEnvelope = {
  phase: "information" | "save" | "confirm";
  values: Record<string, Information>;
  editingSnapshot: string;
  information: {
    draftId: string;
    stepId: string;
    requestId: string;
    expectedVersion: number;
    values: Record<string, Information>;
  };
  save: {
    action: "save";
    projectId: string;
    roundId: string;
    requestId: string;
    stepId: string;
    expectedVersion: number | null;
    body: string;
    evidenceIds: string[];
  };
  confirm: {
    action: "confirm";
    projectId: string;
    roundId: string;
    requestId: string;
    stepId: string;
    expectedVersion: number | null;
    expectedReviewVersion: number | null;
  };
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
    execute = trpc.runtime.execute.useMutation();
  const information = trpc.opc.information.useMutation();
  const [infoEdits, setInfoEdits] = useState<
    Record<string, Record<string, Information>>
  >({});
  const revise = trpc.opc.revise.useMutation();
  const change = trpc.workbench.execute.useMutation(),
    savePlan = trpc.opc.savePlan.useMutation(),
    handoff = trpc.opc.handoff.useMutation();
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<Item[]>([]),
    [dirtyPlan, setDirtyPlan] = useState(false),
    [planCandidate, setPlanCandidate] = useState<Item[] | null>(null),
    [error, setError] = useState("");
  const history = trpc.runtime.view.useQuery(
    { sessionId: read.data?.sessionId ?? "" },
    { enabled: Boolean(read.data?.sessionId) },
  );
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const [mentorInput, setMentorInput] = useState("");
  const [hydratedDraft, setHydratedDraft] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    Record<string, "idle" | "saving" | "saved" | "error">
  >({});
  const infoEditsRef = useRef(infoEdits);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveChain = useRef<Promise<void>>(Promise.resolve());
  const appliedMentor = useRef(new Set<string>());
  const composing = useRef(false);
  const hasUnsavedInformation = Object.keys(infoEdits).length > 0;
  const d = read.data,
    snap = d?.snapshot,
    latest = d?.plans?.[0];
  const busy =
    running ||
    revise.isPending ||
    prepareStep.isPending ||
    execute.isPending ||
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
    const restoredActiveStep =
      typeof local.activeStep === "string" ? local.activeStep : null;
    const legacyMentorInputs =
      local.mentorInputs && typeof local.mentorInputs === "object"
        ? (local.mentorInputs as Record<string, string>)
        : {};
    setActiveStep(restoredActiveStep);
    setMentorInput(
      typeof local.mentorInput === "string"
        ? local.mentorInput
        : (restoredActiveStep &&
              typeof legacyMentorInputs[restoredActiveStep] === "string"
            ? legacyMentorInputs[restoredActiveStep]
            : Object.values(legacyMentorInputs).find(
                (value) => typeof value === "string" && value.trim(),
              )) ?? "",
    );
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
        items,
        dirtyPlan,
        infoEdits,
        planCandidate,
        activeStep,
        mentorInput,
      }),
    );
    const warn = (e: BeforeUnloadEvent) => {
      if (
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
    items,
    dirtyPlan,
    infoEdits,
    planCandidate,
    activeStep,
    mentorInput,
  ]);
  useEffect(() => {
    infoEditsRef.current = infoEdits;
  }, [infoEdits]);
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
  }, [history.data]);
  async function persistInformation(
    stepId: string,
    requestedValues: Record<string, Information>,
  ) {
    const storageKey = "opc-information-autosave:" + draftId + ":" + stepId;
    let wanted = requestedValues;
    let retriedConflict = false;
    setSaveState((old) => ({ ...old, [stepId]: "saving" }));
    try {
      for (;;) {
        let fixed: {
          draftId: string;
          stepId: string;
          requestId: string;
          expectedVersion: number;
          values: Record<string, Information>;
          editingSnapshot: string;
        } | null = null;
        try {
          const raw = sessionStorage.getItem(storageKey);
          if (raw) fixed = JSON.parse(raw);
        } catch {
          throw new Error("OPC_AUTOSAVE_IDENTITY_UNREADABLE");
        }
        if (!fixed) {
          const current = (await read.refetch()).data;
          if (!current) throw new Error("OPC_UNAVAILABLE");
          fixed = {
            draftId,
            stepId,
            requestId: crypto.randomUUID(),
            expectedVersion: current.snapshot.steps[stepId].version,
            values: wanted,
            editingSnapshot: JSON.stringify(wanted),
          };
          sessionStorage.setItem(storageKey, JSON.stringify(fixed));
        }
        try {
          const { editingSnapshot: _editingSnapshot, ...request } = fixed;
          await information.mutateAsync(request);
        } catch (cause) {
          if (
            !retriedConflict &&
            cause instanceof Error &&
            cause.message.includes("OPC_INFORMATION_CONFLICT")
          ) {
            // A version conflict is a definite rollback. Refresh and create a
            // new identity once; ambiguous failures retain the original ID.
            retriedConflict = true;
            sessionStorage.removeItem(storageKey);
            await read.refetch();
            continue;
          }
          throw cause;
        }
        sessionStorage.removeItem(storageKey);
        await read.refetch();
        setInfoEdits((old) => {
          if (
            JSON.stringify(old[stepId] ?? null) !== fixed!.editingSnapshot
          )
            return old;
          const next = { ...old };
          delete next[stepId];
          return next;
        });
        const latestValues = infoEditsRef.current[stepId];
        if (
          !latestValues ||
          JSON.stringify(latestValues) === fixed.editingSnapshot
        )
          break;
        wanted = latestValues;
        retriedConflict = false;
      }
      setSaveState((old) => ({ ...old, [stepId]: "saved" }));
    } catch {
      setSaveState((old) => ({ ...old, [stepId]: "error" }));
      throw new Error("OPC_AUTOSAVE_FAILED");
    }
  }
  function enqueueInformation(
    stepId: string,
    values: Record<string, Information>,
  ) {
    const task = autosaveChain.current.then(() =>
      persistInformation(stepId, values),
    );
    autosaveChain.current = task.catch(() => undefined);
    return task;
  }
  async function flushInformation(stepId: string) {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    const values = infoEditsRef.current[stepId];
    if (values) await enqueueInformation(stepId, values);
    else await autosaveChain.current;
  }
  useEffect(() => {
    if (hydratedDraft !== draftId || composing.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const pending = Object.entries(infoEdits);
    if (!pending.length) return;
    autosaveTimer.current = setTimeout(() => {
      for (const [stepId, values] of pending)
        void enqueueInformation(stepId, values).catch(() => {
          setError("自动保存暂时失败。内容仍保留在本机，可重试保存。");
        });
    }, 700);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [draftId, hydratedDraft, infoEdits]);
  useEffect(() => {
    if (!d || !history.data) return;
    const executions = history.data.executions ?? [];
    for (const execution of executions as Array<{
      executionId: string;
      state: string;
      body: string | null;
      primaryBody: string | null;
    }>) {
      if (
        execution.state !== "completed" ||
        appliedMentor.current.has(execution.executionId)
      )
        continue;
      const turn = d.turns?.find(
        (item: { executionId: string; stepId: string; kind: string }) =>
          item.executionId === execution.executionId && item.kind === "mentor",
      );
      if (!turn) continue;
      const schema = d.information[turn.stepId]?.schema ?? [];
      const rawResponse = execution.body ?? execution.primaryBody;
      // A completed execution can become visible before its public result
      // projection is readable. Do not consume that identity until the result
      // exists, otherwise a later refresh can show the mentor reply without
      // ever applying its form suggestions.
      if (!rawResponse) continue;
      const parsed = readMentorResponse(
        rawResponse,
        new Set(schema.map((field: { id: string }) => field.id)),
      );
      appliedMentor.current.add(execution.executionId);
      if (!Object.keys(parsed.informationPatch).length) continue;
      setInfoEdits((old) => {
        const values = Object.fromEntries(
          schema.map((field: { id: string }) => [
            field.id,
            old[turn.stepId]?.[field.id] ??
              d.information[turn.stepId].values?.[field.id] ?? {
                status: "unknown",
                nature: "unknown",
                value: "",
              },
          ]),
        ) as Record<string, Information>;
        let changed = false;
        for (const [fieldId, suggestion] of Object.entries(
          parsed.informationPatch,
        )) {
          if (values[fieldId]?.value.trim()) continue;
          values[fieldId] = suggestion;
          changed = true;
        }
        return changed ? { ...old, [turn.stepId]: values } : old;
      });
    }
  }, [d, history.data]);
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
      await flushInformation(step.id);
      const key = "opc-step:" + draftId + ":" + step.id;
      const prior = sessionStorage.getItem(key);
      const fixed = prior ? JSON.parse(prior) : {
        request: {
          draftId, stepId: step.id, purpose: "mentor", requestId: crypto.randomUUID(),
          input: mentorInput.trim(),
        },
      };
      sessionStorage.setItem(key, JSON.stringify(fixed));
      // Finish a request retained by the previous UI using its original
      // identities before accepting a newer message.
      if (fixed.information) {
        await information.mutateAsync(fixed.information);
        setInfoEdits(old => {
          if (JSON.stringify(old[step.id] ?? null) !== fixed.editingSnapshot) return old;
          const next = {...old}; delete next[step.id]; return next;
        });
      }
      // Preserve pending requests from the previous UI without changing identity.
      const request = fixed.request ?? fixed;
      if (!request.input?.trim()) throw new Error("OPC_INPUT_REQUIRED");
      const admitted = await prepareStep.mutateAsync(request);
      await execute.mutateAsync({ executionId: admitted.executionId });
      sessionStorage.removeItem(key);
      setMentorInput((old) =>
        old.trim() === request.input.trim() ? "" : old,
      );
    });
  }
  async function confirmStep(step: Step, stepIndex: number) {
    try {
      await flushInformation(step.id);
    } catch {
      setError("请先完成自动保存。内容仍保留在本机，可点击重试自动保存。");
      return;
    }
    const key = "opc-confirm-step:" + draftId + ":" + step.id;
    let fixed: ConfirmStepEnvelope | null;
    try {
      const prior = sessionStorage.getItem(key);
      fixed = prior ? (JSON.parse(prior) as ConfirmStepEnvelope) : null;
    } catch {
      setError("原确认请求无法读取。当前内容已保留，请重新读取状态后再试。");
      return;
    }
    if (!fixed) {
      const current = (await read.refetch()).data;
      if (!current) return;
      const schema = current.information[step.id].schema as Array<{
        id: string;
        title: string;
        required: boolean;
      }>;
      const values = Object.fromEntries(
        schema.map((field) => {
          const value: Information =
            infoEditsRef.current[step.id]?.[field.id] ??
            current.information[step.id].values?.[field.id] ?? {
              status: "unknown",
              nature: "unknown",
              value: "",
            };
          return [
            field.id,
            {
              ...value,
              value: value.value.trim(),
              status:
                value.status === "deferred"
                  ? "deferred"
                  : value.value.trim()
                    ? "confirmed"
                    : "unknown",
            },
          ];
        }),
      ) as Record<string, Information>;
      const missing = schema.filter(
        (field) =>
          field.required &&
          !["confirmed", "deferred"].includes(values[field.id].status),
      );
      if (missing.length) {
        setError(
          "还需要补充这些信息：" + missing.map((field) => field.title).join("、"),
        );
        return;
      }
      if (
        schema.some(
          (field) =>
            values[field.id].status === "deferred" &&
            !values[field.id].value.trim(),
        )
      ) {
        setError("暂时无法确定的信息，请简单写明原因。");
        return;
      }
      const body = schema
        .filter((field) => values[field.id].value)
        .map(
          (field) =>
            `${field.title}\n${
              values[field.id].status === "deferred" ? "（暂缓确认）" : ""
            }${values[field.id].value}`,
        )
        .join("\n\n");
      fixed = {
        phase: "information",
        values,
        editingSnapshot: JSON.stringify(infoEditsRef.current[step.id] ?? null),
        information: {
          draftId,
          stepId: step.id,
          requestId: crypto.randomUUID(),
          expectedVersion: current.snapshot.steps[step.id].version,
          values,
        },
        save: {
          action: "save",
          projectId: current.projectId,
          roundId: current.roundId,
          requestId: crypto.randomUUID(),
          stepId: step.id,
          expectedVersion: null,
          body,
          evidenceIds: current.snapshot.steps[step.id].evidenceIds,
        },
        confirm: {
          action: "confirm",
          projectId: current.projectId,
          roundId: current.roundId,
          requestId: crypto.randomUUID(),
          stepId: step.id,
          expectedVersion: null,
          expectedReviewVersion: null,
        },
      };
      sessionStorage.setItem(key, JSON.stringify(fixed));
    }
    const request = fixed;
    await run(async () => {
      if (request.phase === "information") {
        await information.mutateAsync(request.information);
        request.phase = "save";
        sessionStorage.setItem(key, JSON.stringify(request));
        setInfoEdits((old) => {
          if (
            JSON.stringify(old[step.id] ?? null) !== request.editingSnapshot
          )
            return old;
          const next = { ...old };
          delete next[step.id];
          return next;
        });
      }
      if (request.phase === "save") {
        if (request.save.expectedVersion === null) {
          const current = (await read.refetch()).data;
          if (!current) throw new Error("OPC_UNAVAILABLE");
          request.save.expectedVersion = current.snapshot.steps[step.id].version;
          request.save.evidenceIds = current.snapshot.steps[step.id].evidenceIds;
          sessionStorage.setItem(key, JSON.stringify(request));
        }
        await change.mutateAsync({
          ...request.save,
          expectedVersion: request.save.expectedVersion!,
        });
        request.phase = "confirm";
        sessionStorage.setItem(key, JSON.stringify(request));
      }
      if (request.phase === "confirm") {
        if (request.confirm.expectedVersion === null) {
          const current = (await read.refetch()).data;
          if (!current) throw new Error("OPC_UNAVAILABLE");
          const state = current.snapshot.steps[step.id];
          request.confirm.expectedVersion = state.version;
          request.confirm.expectedReviewVersion = state.reviewVersion;
          sessionStorage.setItem(key, JSON.stringify(request));
        }
        await change.mutateAsync({
          ...request.confirm,
          expectedVersion: request.confirm.expectedVersion!,
          expectedReviewVersion: request.confirm.expectedReviewVersion!,
        });
      }
      sessionStorage.removeItem(key);
      if (stepIndex < (snap.workflow.steps as Step[]).length - 1)
        setActiveStep((snap.workflow.steps as Step[])[stepIndex + 1].id);
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
      if (!candidate.valid) {
        // This execution completed and returned a body that cannot be used as
        // a plan. It is safe to create a new request after the user edits the
        // inputs; timeouts and unknown execution state retain identity.
        sessionStorage.removeItem(key);
        throw new Error("OPC_PLAN_RESPONSE_INVALID");
      }
      setPlanCandidate(candidate.body);
      sessionStorage.removeItem(key);
    });
  }
  async function confirmPlan() {
    await run(async () => {
      if (
        !latest ||
        dirtyPlan ||
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
      try {
        await handoff.mutateAsync(fixed);
      } catch (cause) {
        // This specific SQL rejection rolls the entire transaction back. An old
        // expected account revision cannot become valid again (monotonic).
        // Timeouts, lost replies and all other errors retain the original request.
        if (cause instanceof Error && cause.message === "OPC_ACCOUNT_CONFLICT") {
          sessionStorage.removeItem(key);
          await list.refetch();
        }
        throw cause;
      }
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
  type MentorTurn = {
    executionId: string;
    stepId: string;
    kind: string;
  };
  type MentorExecution = {
    executionId: string;
    input: string | null;
    body: string | null;
    primaryBody: string | null;
    state: string;
  };
  const mentorTurns = new Map<string, MentorTurn>(
    ((d.turns ?? []) as MentorTurn[])
      .filter((turn) => turn.kind === "mentor")
      .map((turn) => [turn.executionId, turn]),
  );
  const mentorExecutions = Array.from(
    new Map(
      ((history.data?.executions ?? []) as MentorExecution[])
        .filter((execution) => mentorTurns.has(execution.executionId))
        .map((execution) => [execution.executionId, execution]),
    ).values(),
  );
  const pendingMentor = mentorExecutions.find(
    (execution) => !["completed", "cancelled"].includes(execution.state),
  );
  return (
    <main className="mx-auto max-w-[90rem] space-y-4 p-4 sm:p-6 text-[var(--text-primary)]">
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
          正在保存最新修改。保存完成前不会确认步骤或采用计划。
        </p>
      )}
      <section aria-label="当前定位步骤" className="space-y-4">
        {snap.workflow.steps.map((step: Step, index: number) => {
          if (step.id !== selectedStep.id) return null;
          const s = snap.steps[step.id];
          const schema = d.information[step.id].schema as Array<{
            id: string;
            title: string;
            required: boolean;
          }>;
          return (
            <article
              key="positioning-workspace"
              className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4"
            >
              <h2 className="text-lg">
                {index + 1}. {step.title} {s.valid ? "· 已确认" : "· 待确认"}
              </h2>
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)]">
                <aside
                  aria-label="全程导师聊天"
                  className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 lg:sticky lg:top-4"
                >
                  <div>
                    <p className="text-xs text-[var(--text-secondary)]">全程同一对话</p>
                    <h3 className="font-semibold">
                      和导师一起完成全部 {steps.length} 步
                    </h3>
                  </div>
                  <div
                    aria-label="当前导师任务"
                    className="rounded-xl bg-[var(--bg-tertiary)] p-3"
                  >
                    <p className="text-xs text-[var(--text-secondary)]">
                      当前正在梳理 · {step.title}
                    </p>
                    <p className="mt-1 text-sm">
                      {schema[0]
                        ? `${schema[0].title}，你目前是怎么想的？`
                        : "说说你现在最想解决的问题。"}
                    </p>
                  </div>
                  <div
                    ref={chatScroll}
                    role="log"
                    aria-label="完整导师消息"
                    aria-live="polite"
                    className="max-h-[55vh] min-h-56 space-y-3 overflow-y-auto overscroll-contain pr-2"
                  >
                    <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                      <span className="text-xs text-[var(--text-secondary)]">导师</span>
                      <p className="mt-1 whitespace-pre-wrap break-words">
                        我会在同一个对话里陪你完成全部步骤，一次问一个问题，并把从回答中梳理出的信息放到右侧对应表单，供你核对。
                      </p>
                    </div>
                    {mentorExecutions.map((execution) => {
                      const turn = mentorTurns.get(execution.executionId);
                      const turnStep = steps.find(
                        (candidate) => candidate.id === turn?.stepId,
                      );
                      const turnSchema = turn
                        ? (d.information[turn.stepId]?.schema ?? [])
                        : [];
                      const parsed = readMentorResponse(
                        execution.body ?? execution.primaryBody,
                        new Set(
                          turnSchema.map((field: { id: string }) => field.id),
                        ),
                      );
                      return (
                        <div key={execution.executionId} className="space-y-2">
                          <div className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
                            <span className="text-xs text-[var(--text-secondary)]">
                              你{turnStep ? ` · ${turnStep.title}` : ""}
                            </span>
                            <p className="mt-1 whitespace-pre-wrap break-words">
                              {execution.input ?? "内容暂不可用"}
                            </p>
                          </div>
                          <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
                            <span className="text-xs text-[var(--text-secondary)]">
                              导师{turnStep ? ` · ${turnStep.title}` : ""}
                            </span>
                            <p className="mt-1 whitespace-pre-wrap break-words">
                              {parsed.message ||
                                (execution.state === "cancelled"
                                  ? "这条回复未发给模型，你可以直接重新描述问题。"
                                  : "这条回复还在核对原请求，不会重复发送或重复扣费。")}
                            </p>
                          </div>
                          {!["completed", "cancelled"].includes(
                            execution.state,
                          ) && (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                run(() =>
                                  execute.mutateAsync({
                                    executionId: execution.executionId,
                                  }),
                                )
                              }
                            >
                              继续核对这条回复
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <label className="block text-sm">
                    回复导师
                    <Textarea
                      className="resize-none"
                      aria-label="给导师的回复"
                      value={mentorInput}
                      disabled={busy || Boolean(pendingMentor) || snap.state !== "draft"}
                      onChange={(event) => setMentorInput(event.target.value)}
                      placeholder="用自己的话说就好，可以多聊几轮。"
                      maxLength={8000}
                    />
                  </label>
                  <Button
                    disabled={
                      busy ||
                      Boolean(pendingMentor) ||
                      snap.state !== "draft" ||
                      !mentorInput.trim()
                    }
                    onClick={() => ask(step)}
                  >
                    {busy ? "正在回复…" : "发送"}
                  </Button>
                  <p className="text-xs text-[var(--text-secondary)]">
                    六个步骤共用这一条对话记录。右侧只切换当前表单；刷新或重新登录后仍从原 Session 继续。当前为隔离模拟，不调用真实模型。
                  </p>
                </aside>
                <section
                  aria-label="本步填写信息"
                  className="space-y-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-[var(--text-secondary)]">当前步骤表单</p>
                      <h3 className="font-semibold">核对导师梳理的信息</h3>
                    </div>
                    <p role="status" className="text-xs text-[var(--text-secondary)]">
                      {saveState[step.id] === "saving"
                        ? "正在自动保存…"
                        : saveState[step.id] === "error"
                          ? "自动保存失败"
                          : saveState[step.id] === "saved"
                            ? "已自动保存"
                            : "修改后自动保存"}
                    </p>
                  </div>
                  <p className="text-sm text-[var(--text-secondary)]">
                    你可以直接填写，也可以和左侧导师聊。导师建议会以“待核对”状态填入；只有你确认本步骤后才会成为正式结果。
                  </p>
                  <div className="space-y-4">
                  {schema.map((field) => {
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
                        <div key={field.id} className="space-y-2">
                          <label className="block font-medium" htmlFor={`${step.id}-${field.id}`}>
                            {field.title}
                            {field.required ? "（必需）" : ""}
                          </label>
                          <Textarea
                            id={`${step.id}-${field.id}`}
                            aria-label={field.title}
                            maxLength={400}
                            className="min-h-20 resize-none"
                            disabled={busy || snap.state !== "draft"}
                            value={value.value}
                            onCompositionStart={() => {
                              composing.current = true;
                            }}
                            onCompositionEnd={() => {
                              composing.current = false;
                              const values = infoEditsRef.current[step.id];
                              if (values)
                                void enqueueInformation(step.id, values).catch(() =>
                                  setError("自动保存暂时失败。内容仍保留在本机，可重试保存。"),
                                );
                            }}
                            onChange={(event) =>
                              updateInfo({
                                value: event.target.value,
                                status: event.target.value.trim()
                                  ? "confirmed"
                                  : "unknown",
                                nature:
                                  value.nature === "unknown"
                                    ? "decision"
                                    : value.nature,
                              })
                            }
                          />
                          {value.status === "provisional" && (
                            <p className="text-xs text-[var(--text-secondary)]">
                              导师已根据你的回答填入，请核对或修改。
                            </p>
                          )}
                          <details className="text-sm text-[var(--text-secondary)]">
                            <summary className="cursor-pointer">
                              这项现在还不能确定
                            </summary>
                            <UiSelect
                              value={value.status}
                              disabled={busy || snap.state !== "draft"}
                              onValueChange={(status) =>
                                updateInfo({
                                  status: status as Information["status"],
                                })
                              }
                            >
                              <SelectTrigger
                                className="mt-2 w-full sm:w-56"
                                aria-label={field.title + " 状态"}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries({
                                  unknown: "尚未知",
                                  unclear: "需要继续聊",
                                  provisional: "导师已填写，待我核对",
                                  confirmed: "我已确认",
                                  deferred: "暂时无法确定",
                                }).map(([key, label]) => (
                                  <SelectItem key={key} value={key}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </UiSelect>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                  {saveState[step.id] === "error" && (
                    <Button
                      variant="outline"
                      disabled={information.isPending}
                      onClick={() => {
                        const values = infoEditsRef.current[step.id];
                        if (values)
                          void enqueueInformation(step.id, values).catch(() =>
                            setError("自动保存仍未成功。内容已保留，请稍后重试。"),
                          );
                      }}
                    >
                      重试自动保存
                    </Button>
                  )}
                  <Button
                    className="w-full"
                    disabled={busy || snap.state !== "draft"}
                    onClick={() => confirmStep(step, index)}
                  >
                    {s.valid ? "重新确认本步骤" : "确认本步骤"}
                  </Button>
                  <p className="text-xs text-[var(--text-secondary)]">
                    确认会把右侧表单冻结为本步骤结果，不再额外生成一份重复成果。
                  </p>
                </section>
              </div>
              {s.valid && index < steps.length - 1 && (
                <Button
                  disabled={busy || hasUnsavedInformation}
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
                  className="resize-none"
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
                  busy || hasUnsavedInformation
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
