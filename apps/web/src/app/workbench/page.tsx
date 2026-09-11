/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ReportWorkActions, WorkSource } from "./report-work-actions";
import { GenerationPanel } from "./generation-panel";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase";
import type {
  ArtifactSnapshot,
  ArtifactProject,
  ArtifactRound,
  ArtifactReport,
  PublicWorkflow,
} from "@repo/api/src/services/artifacts/public";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@repo/api/src/root";
type Catalog = inferRouterOutputs<AppRouter>["workbench"]["catalog"];
type Draft = {
  scope: string;
  editId: string;
  candidateId?: string;
  body: string;
  evidenceIds: string[];
  baseVersion: number;
  dirty: boolean;
};
type Action = (() => Promise<void>) & { changesScope?: boolean };
const panel = "rounded-xl border border-white/10 bg-white/[0.03] p-5";
const label = "text-sm text-zinc-400";
const id = () => crypto.randomUUID();
export default function WorkbenchPage() {
  const api = trpc.useUtils().client.workbench;
  const [catalog, setCatalog] = useState<Catalog>([]),
    [projects, setProjects] = useState<ArtifactProject[]>([]),
    [rounds, setRounds] = useState<ArtifactRound[]>([]);
  const [snapshot, setSnapshot] = useState<ArtifactSnapshot | null>(null),
    [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState(""),
    [report, setReport] = useState<ArtifactReport | null>(null),
    [comparison, setComparison] = useState<ArtifactSnapshot | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(true);
  const [sourceDrafts, setSourceDrafts] = useState<
    Record<string, { editId: string; body: string; supersedes: string }>
  >({});
  const sourceScope = snapshot ? `${snapshot.projectId}/${snapshot.roundId}` : "";
  const evidence = sourceDrafts[sourceScope]?.body ?? "";
  const supersedes = sourceDrafts[sourceScope]?.supersedes ?? "";
  const setEvidence = (body: string) => setSourceDrafts((old) => ({
    ...old, [sourceScope]: { editId: id(), body, supersedes: old[sourceScope]?.supersedes ?? "" },
  }));
  const setSupersedes = (value: string) => setSourceDrafts((old) => ({
    ...old, [sourceScope]: { editId: id(), body: old[sourceScope]?.body ?? "", supersedes: value },
  }));
  const [upgrade, setUpgrade] = useState(""),
    [account, setAccount] = useState<Record<string, string>>({});
  const pending = useRef<Action | null>(null),
    locked = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const dirty = Object.values(drafts).some((d) => d.dirty);
  // Source forms survive project/round navigation, so protect every retained
  // scope from a full page unload, including a currently hidden source draft.
  const unsaved = dirty || Object.values(sourceDrafts).some((d) => d.body !== "" || d.supersedes !== "");
  const currentProject = projects.find(
    (p) => p.projectId === snapshot?.projectId,
  );
  async function discover() {
    const [c, p] = await Promise.all([
      api.catalog.query(),
      api.projects.query(),
    ]);
    return { catalog: c, projects: p };
  }
  function applyDiscovery(result: Awaited<ReturnType<typeof discover>>) {
    setCatalog(result.catalog);
    setProjects(result.projects);
  }
  async function readProject(projectId: string, roundId?: string) {
    const history = await api.rounds.query({ projectId });
    const current =
      roundId ??
      history.find((r) => r.state === "draft")?.roundId ??
      history
        .filter((r) => r.state === "published")
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]?.roundId ??
      history.at(-1)?.roundId;
    if (!current) return null;
    const s = await api.read.query({ projectId, roundId: current });
    return { history, snapshot: s };
  }
  function applyProject(result: Awaited<ReturnType<typeof readProject>>, preserve = false) {
    if (!result) return;
    setRounds(result.history);
    applySnapshot(result.snapshot, preserve);
  }
  async function load(projectId: string, roundId?: string) {
    applyProject(await readProject(projectId, roundId));
  }
  function applySnapshot(s: ArtifactSnapshot, preserve = true) {
    setSnapshot(s);
    setReport(null);
    setComparison(null);
    setSelected((old) =>
      s.workflow.steps.some((x) => x.id === old) ? old : s.workflow.steps[0].id,
    );
    setDrafts((old) =>
      Object.fromEntries(
        Object.entries(s.steps).map(([key, v]) => [
          key,
          preserve &&
          old[key]?.dirty &&
          old[key].scope === `${s.projectId}/${s.roundId}`
            ? old[key]
            : {
                scope: `${s.projectId}/${s.roundId}`,
                editId: id(),
                body: v.body ?? "",
                evidenceIds: v.evidenceIds,
                baseVersion: v.version,
                dirty: false,
              },
        ]),
      ),
    );
  }
  async function run(action: Action, retryable = false) {
    if (locked.current) return;
    if (action.changesScope && Object.values(draftsRef.current).some((d) => d.dirty)) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    // A new action owns the current error/recovery UI. Read-only actions must
    // not resurrect a failed write from a discarded edit or previous scope.
    pending.current = retryable ? action : null;
    try {
      await action();
      if (pending.current === action) pending.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重新加载。");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => {
      const result = await discover();
      applyDiscovery(result);
      if (result.projects.length) await load(result.projects[0].projectId);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let previous: string | null | undefined;
    const {
      data: { subscription },
    } = createClient().auth.onAuthStateChange((event, session) => {
      const current = session?.user.id ?? null;
      if (previous !== undefined && current !== previous) {
        setSnapshot(null);
        setDrafts({});
        setSourceDrafts({});
        setProjects([]);
        setRounds([]);
        setReport(null);
        setComparison(null);
        pending.current = null;
        window.location.replace(
          current ? "/workbench" : "/login?redirect=/workbench",
        );
      }
      previous = current;
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  async function refresh() {
    const s = snapshotRef.current;
    // Parallel branches only fetch. A failed batch leaves no pending branch
    // which can later commit stale page state after run() releases the UI.
    const [discovery, project] = await Promise.all([
      discover(), s ? readProject(s.projectId, s.roundId) : null,
    ]);
    applyDiscovery(discovery);
    applyProject(project, true);
  }
  async function refreshCurrent(history = false) {
    const s = snapshotRef.current;
    if (!s) return;
    const [current, updatedRounds, updatedProjects] = await Promise.all([
      api.read.query({ projectId: s.projectId, roundId: s.roundId }),
      history ? api.rounds.query({ projectId: s.projectId }) : undefined,
      history ? api.projects.query() : undefined,
    ]);
    applySnapshot(current);
    if (updatedRounds) setRounds(updatedRounds);
    if (updatedProjects) setProjects(updatedProjects);
  }
  function execute(command: Parameters<typeof api.execute.mutate>[0]) {
    void run(async () => {
      await api.execute.mutate(command);
      await refreshCurrent(command.action === "abandon");
    }, true);
  }
  function saveSource() {
    if (!snapshot || !sourceDrafts[sourceScope]) return;
    const scope = sourceScope, submitted = sourceDrafts[scope];
    const command = {
      action: "userEvidence" as const,
      projectId: snapshot.projectId,
      roundId: snapshot.roundId,
      requestId: id(),
      body: submitted.body,
      observedAt: null,
      supersedes: submitted.supersedes || null,
    };
    void run(async () => {
      await api.execute.mutate(command);
      setSourceDrafts((old) => {
        if (old[scope]?.editId !== submitted.editId) return old;
        const next = { ...old };
        delete next[scope];
        return next;
      });
      await refreshCurrent();
    }, true);
  }
  async function saveEntries(
    s: ArtifactSnapshot,
    entries: Record<string, Draft>,
    requests: Record<string, string>,
  ) {
    for (const [stepId, d] of Object.entries(entries))
      if (d.dirty) {
        await api.execute.mutate({
          ...(d.candidateId
            ? { action: "saveCandidate" as const, candidateId: d.candidateId }
            : { action: "save" as const, evidenceIds: d.evidenceIds }),
          projectId: s.projectId,
          roundId: s.roundId,
          requestId: requests[stepId],
          stepId,
          expectedVersion: d.baseVersion,
          body: d.body,
        });
        setDrafts((old) => {
          const current = old[stepId];
          // A replay acknowledges the submitted edit, never a later local edit
          // or another project/round which happens to use the same step ID.
          if (!current || current.scope !== d.scope) return old;
          if (current.editId === d.editId)
            return {
              ...old,
              [stepId]: {
                ...current,
                baseVersion: d.baseVersion + 1,
                candidateId: undefined,
                dirty: false,
              },
            };
          return {
            ...old,
            [stepId]: {
              ...current,
              candidateId:
                current.candidateId === d.candidateId
                  ? undefined
                  : current.candidateId,
              baseVersion:
                current.baseVersion === d.baseVersion
                  ? d.baseVersion + 1
                  : current.baseVersion,
            },
          };
        });
      }
  }
  function save(publish = false) {
    if (!snapshot) return;
    const s = snapshot,
      entries = structuredClone(drafts),
      requests = Object.fromEntries(Object.keys(entries).map((k) => [k, id()])),
      publishId = id();
    void run(async () => {
      if (
        publish &&
        Object.entries(entries).some(
          ([key, value]) =>
            draftsRef.current[key]?.scope !== value.scope ||
            draftsRef.current[key]?.editId !== value.editId,
        )
      ) {
        // An old publish must not create a report after later local edits.
        // Read an already committed result; never change its request/payload or
        // resend an uncommitted publication which no longer matches the editor.
        const recovered = await api.read.query({
          projectId: s.projectId,
          roundId: s.roundId,
        });
        applySnapshot(recovered);
        if (recovered.state === "published") await refreshCurrent(true);
        setNotice(
          recovered.state === "published"
            ? "已读取现有正式版。后续未保存输入仍保留，可复制到新轮次继续处理。"
            : "检测到后续编辑，本次未重发发布。请先保存并复核确认，再发布正式版。",
        );
        return;
      }
      await saveEntries(s, entries, requests);
      const latest = await api.read.query({
        projectId: s.projectId,
        roundId: s.roundId,
      });
      if (publish) {
        if (
          Object.values(latest.steps).some((x) => !x.valid) ||
          Object.keys(latest.steps).some(
            (k) =>
              latest.steps[k].version !== s.steps[k].version ||
              latest.steps[k].reviewVersion !== s.steps[k].reviewVersion,
          )
        ) {
          applySnapshot(latest);
          setNotice("编辑已保存。请复核并确认所有待确认步骤，再发布正式版。");
          return;
        }
        await api.execute.mutate({
          action: "publish",
          projectId: s.projectId,
          roundId: s.roundId,
          requestId: publishId,
          expectedSteps: Object.fromEntries(
            Object.entries(s.steps).map(([k, v]) => [
              k,
              { version: v.version, reviewVersion: v.reviewVersion },
            ]),
          ),
        });
      }
      if (publish) await refreshCurrent(true);
      else applySnapshot(latest);
      setNotice(
        publish
          ? "正式版已发布。"
          : "本次提交已保存；后续未保存输入会继续保留。",
      );
    }, true);
  }
  const availableAccounts = (c: Catalog[number]) =>
    c.accounts.filter((a) => !projects.some((p) => p.account === a));
  const selectedAccount = (c: Catalog[number]) =>
    availableAccounts(c).includes(account[c.id])
      ? account[c.id]
      : availableAccounts(c)[0];
  function start(registration?: string, fromRoundId?: string) {
    const selectedEntry = catalog.find((x) => x.id === registration),
      projectId = fromRoundId ? snapshot!.projectId : id();
    const input = {
      projectId,
      roundId: id(),
      requestId: id(),
      ...(registration ? { registration } : {}),
      ...(fromRoundId
        ? { fromRoundId, ...(registration ? { upgrade: true as const } : {}) }
        : {}),
      ...(!fromRoundId
        ? {
            account:
              selectedEntry?.workflow.kind === "social"
                ? selectedAccount(selectedEntry)
                : null,
          }
        : {}),
    };
    const action = Object.assign(async () => {
      if (fromRoundId && currentProject?.workKind === 'script') throw new Error('请使用作品定位来源中的修订入口。');
      const created = await api.start.mutate(input);
      const [discovery, project] = await Promise.all([
        discover(), readProject(projectId, created.roundId),
      ]);
      applyDiscovery(discovery);
      applyProject(project);
      setUpgrade("");
    }, { changesScope: true });
    void run(action, true);
  }
  const step = snapshot?.workflow.steps.find((x) => x.id === selected),
    draft = drafts[selected],
    server = snapshot?.steps[selected];
  const newMethod = catalog.find((x) => x.id === upgrade);
  return (
    <main aria-busy={busy} className="min-h-screen break-words bg-[#111214] text-zinc-100">
      <header className="border-b border-white/10 px-6 py-5 flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-wide">
          Graylum
        </Link>
        <nav className="flex gap-5 text-sm">
          <Link href="/marketplace">功能广场</Link>
          <Link href="/chat">普通对话</Link>
          <Link href="/profile">个人中心</Link>
        </nav>
      </header>
      <div className="mx-auto max-w-7xl px-5 py-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-sm text-amber-300">我的 Skill 项目</p>
            <h1 className="text-3xl font-semibold">工作台</h1>
            <p className="mt-3 text-sm text-zinc-400">
              逐步编辑、确认与复核，将想法保存为可追溯的正式成果。
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            重新加载服务端状态
          </Button>
        </div>
        {snapshot && currentProject?.workKind === "script" && <WorkSource projectId={snapshot.projectId} roundId={snapshot.roundId} title={currentProject.title} canRevise={!busy && !unsaved && snapshot.state === "published" && !rounds.some(r=>r.state === "draft")} onRevised={async roundId=>{await load(snapshot.projectId,roundId);applyDiscovery(await discover());}}/> }
        {snapshot && <Button className="mb-5" disabled={busy || unsaved} onClick={() => { const selected=snapshot; const requestId=crypto.randomUUID(); void run(async()=>{ const binding=await api.chatEnter.mutate({projectId:selected.projectId,roundId:selected.roundId,requestId});window.location.assign(`/chat?conversation=${binding.conversationId}`); }); }}>在聊天中继续此轮次</Button>}
        {error && (
          <div
            role="alert"
            className="mb-5 rounded-lg border border-red-400/40 p-4 text-red-200"
          >
            {error}
            <p className="mt-2 text-sm">
              本地未保存输入仍保留。先重新加载并比较；结果未知时可用同一请求恢复。
            </p>
            {pending.current && (
              <Button
                variant="outline"
                disabled={busy || Boolean(dirty && pending.current.changesScope)}
                onClick={() => {
                  const retry = pending.current;
                  if (retry) void run(retry, true);
                }}
              >
                重试同一请求
              </Button>
            )}
            {dirty && pending.current?.changesScope && (
              <p className="mt-2 text-sm">当前项目有新的未保存编辑，暂不能重试切换项目。请先保存或放弃这些编辑。</p>
            )}
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="mb-5 rounded-lg bg-amber-200/10 p-4 text-amber-100"
          >
            {notice}
          </p>
        )}
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-5 break-words">
            <section className={panel}>
              <h2 className="mb-4 font-medium">我的项目</h2>
              {projects.length === 0 && !busy && (
                <p className={label}>还没有项目。</p>
              )}
              {projects.map((p) => (
                <button
                  key={p.projectId}
                  disabled={busy || dirty}
                  className="mb-2 block w-full rounded-lg border border-white/10 p-3 text-left hover:bg-white/5"
                  onClick={() => void run(() => load(p.projectId))}
                >
                  <span>
                    {p.workKind === "script" ? p.title : catalog.find((c) => c.skillId === p.skillId)?.label ?? p.title}
                  </span>
                  <span className="block text-xs text-zinc-400">
                    {p.linkedAccount ?? p.account ?? "文档项目"} · 正式 v{p.currentVersion}
                  </span>
                </button>
              ))}
            </section>
            <section className={panel}>
              <h2 className="mb-4 font-medium">开始新项目</h2>
              {!catalog.length && !busy && (
                <p className={label}>
                  尚无已配置且可执行的工作流。普通文档 Skill
                  可继续在对话中使用。
                </p>
              )}
              {catalog
                .filter((c) =>
                  c.workflow.kind === "document"
                    ? !projects.some((p) => p.workKind !== "script" && p.skillId === c.skillId)
                    : !c.accounts.length || availableAccounts(c).length > 0,
                )
                .map((c) => (
                  <div key={c.id} className="mb-4">
                    <p>{c.label}</p>
                    <p className="mb-2 text-xs text-zinc-400">
                      {c.workflow.steps.length} 步 · 方法 v{c.workflow.version}
                    </p>
                    {c.workflow.kind === "social" && (
                      <select
                        aria-label={`${c.label} 已验证账号`}
                        className="mb-2 w-full bg-zinc-900 p-2"
                        value={selectedAccount(c) ?? ""}
                        onChange={(e) =>
                          setAccount({ ...account, [c.id]: e.target.value })
                        }
                      >
                        {availableAccounts(c).map((a) => (
                          <option key={a}>{a}</option>
                        ))}
                      </select>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-auto max-w-full whitespace-normal break-all py-2"
                      disabled={
                        busy ||
                        dirty ||
                        (c.workflow.kind === "social" && !c.accounts.length)
                      }
                      onClick={() => start(c.id)}
                    >
                      创建 {c.label}
                    </Button>
                    {c.workflow.kind === "social" && !c.accounts.length && (
                      <p className={label}>尚未接入可验证的账号。</p>
                    )}
                  </div>
                ))}
            </section>
          </aside>
          <div className="min-w-0 space-y-5">
            {snapshot && (
              <>
                <section className={panel}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-xl">
                        {snapshot.workflow.report.title}
                      </h2>
                      <p className={label}>
                        {snapshot.state === "draft"
                          ? "当前草稿"
                          : snapshot.state === "published"
                            ? "正式成果"
                            : "已放弃草稿"}{" "}
                        · 当前正式 v
                        {currentProject?.currentVersion ??
                          snapshot.currentVersion}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busy || snapshot.state !== "draft"}
                        variant="outline"
                        onClick={() => save()}
                      >
                        保存全部编辑
                      </Button>
                      <Button
                        disabled={busy || snapshot.state !== "draft"}
                        onClick={() => save(true)}
                      >
                        发布正式版
                      </Button>
                    </div>
                  </div>
                  <p className="mt-4 text-xs text-zinc-500 break-all">
                    方法版本 {snapshot.workflow.version} · 固定 revision{" "}
                    {snapshot.revisionId}
                  </p>
                  {dirty && (
                    <p className="mt-3 text-sm text-amber-200">
                      有未保存编辑。发布会先保存，随后检查全部确认。
                    </p>
                  )}
                </section>
                <div className="flex flex-wrap gap-2" aria-label="流程步骤">
                  {snapshot.workflow.steps.map((s, i) => (
                    <button
                      key={s.id}
                      className={`rounded-lg border px-4 py-3 text-left ${selected === s.id ? "border-amber-300 text-amber-200" : "border-white/10"}`}
                      onClick={() => setSelected(s.id)}
                    >
                      <span className="block">
                        {i + 1}. {s.title}
                      </span>
                      <span className="text-xs">
                        {snapshot.steps[s.id].valid
                          ? "已确认"
                          : "待确认 / 复核"}
                        {drafts[s.id]?.dirty ? " · 未保存" : ""}
                      </span>
                    </button>
                  ))}
                </div>
                {step && draft && server && (
                  <section className={panel}>
                    <h3 className="text-lg">{step.title}</h3>
                    <p className="my-3 text-sm text-zinc-400">
                      依赖：
                      {step.dependsOn
                        .map(
                          (k) =>
                            snapshot.workflow.steps.find((s) => s.id === k)
                              ?.title,
                        )
                        .join("、") || "无"}{" "}
                      · 确认至少 {step.minLength} 个有效字符
                      {step.requiresEvidence ? "，需要采用来源" : ""}
                    </p>
                    {server.body === null && (
                      <p className="mb-3 text-amber-200">
                        相关来源已受限，服务器已隐藏这份正文。历史访问限制不代表物理删除。
                      </p>
                    )}
                    <textarea
                      aria-label={`${step.title} 工作稿`}
                      className="min-h-64 w-full rounded-lg border border-white/15 bg-black/20 p-4 leading-7 focus:border-amber-300 focus:outline-none"
                      maxLength={step.maxLength}
                      readOnly={snapshot.state !== "draft" || busy}
                      value={draft.body}
                      onChange={(e) =>
                        setDrafts({
                          ...drafts,
                          [selected]: {
                            ...draft,
                            body: e.target.value,
                            editId: id(),
                            dirty: true,
                          },
                        })
                      }
                    />
                    <div className="my-3 flex flex-wrap gap-3 text-xs text-zinc-400">
                      <span>本地基于版本 {draft.baseVersion}</span>
                      <span>服务器版本 {server.version}</span>
                      <span>依赖复核版本 {server.reviewVersion}</span>
                    </div>
                    {draft.dirty && draft.baseVersion !== server.version && (
                      <div className="my-4 rounded-lg border border-amber-300/40 p-4">
                        <h4>版本冲突：服务器已有新内容</h4>
                        <pre className="my-3 whitespace-pre-wrap break-words text-sm">
                          {server.body ?? "来源受限"}
                        </pre>
                        <Button
                          variant="outline"
                          onClick={() => {
                            pending.current = null;
                            setError("");
                            setDrafts({
                              ...drafts,
                              [selected]: {
                                ...draft,
                                baseVersion: server.version,
                                editId: id(),
                              },
                            });
                          }}
                        >
                          已比较，保留我的输入作为下一版
                        </Button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3">
                      <Button
                        disabled={
                          busy || draft.dirty || snapshot.state !== "draft"
                        }
                        onClick={() =>
                          execute({
                            action: "confirm",
                            projectId: snapshot.projectId,
                            roundId: snapshot.roundId,
                            requestId: id(),
                            stepId: selected,
                            expectedVersion: server.version,
                            expectedReviewVersion: server.reviewVersion,
                          })
                        }
                      >
                        确认当前工作稿
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy || !draft.dirty}
                        onClick={() => {
                          pending.current = null;
                          setError("");
                          setDrafts({
                            ...drafts,
                            [selected]: {
                              scope: `${snapshot.projectId}/${snapshot.roundId}`,
                              editId: id(),
                              body: server.body ?? "",
                              evidenceIds: server.evidenceIds,
                              baseVersion: server.version,
                              dirty: false,
                            },
                          });
                        }}
                      >
                        放弃此步骤本地编辑
                      </Button>
                    </div>
                    <GenerationPanel key={`${snapshot.projectId}/${snapshot.roundId}/${selected}`} snapshot={snapshot} stepId={selected} disabled={busy || dirty}
                      refresh={async (projectId, roundId) => {
                        const observed = snapshotRef.current;
                        const next = await api.read.query({ projectId, roundId });
                        if (!locked.current && observed === snapshotRef.current && observed?.projectId === projectId && observed?.roundId === roundId) applySnapshot(next, true);
                      }} />
                    <details className="mt-5">
                      <summary>此步骤确认历史与候选</summary>
                      {snapshot.confirmations
                        .filter((c) => c.stepId === selected)
                        .map((c) => (
                          <div
                            key={c.id}
                            className="mt-3 border-t border-white/10 pt-3"
                          >
                            <p className={label}>
                              确认版本 {c.version} · 复核 {c.reviewVersion}
                            </p>
                            <pre className="whitespace-pre-wrap break-words">
                              {c.body ?? "来源已受限"}
                            </pre>
                          </div>
                        ))}
                      {snapshot.candidates
                        .filter((c) => c.stepId === selected)
                        .map((c) => (
                          <div key={c.id} className="mt-3">
                            <p className={label}>候选（不会自动覆盖工作稿）</p>
                            <pre className="whitespace-pre-wrap break-words">
                              {c.body ?? "来源已受限"}
                            </pre>
                            {c.body !== null && (
                              <Button
                                disabled={
                                  busy ||
                                  snapshot.state !== "draft" ||
                                  c.directEvidenceIds === null
                                }
                                onClick={() =>
                                  setDrafts({
                                    ...drafts,
                                    [selected]: {
                                      ...draft,
                                      body: c.body!,
                                      evidenceIds: c.directEvidenceIds!,
                                      candidateId: c.id,
                                      editId: id(),
                                      dirty: true,
                                    },
                                  })
                                }
                              >
                                采用到本地工作稿
                              </Button>
                            )}
                          </div>
                        ))}
                    </details>
                  </section>
                )}
                <section className={panel}>
                  <h3 className="mb-4 text-lg">来源与用户补充</h3>
                  <p className={`mb-4 ${label}`}>
                    补充来源后，在步骤中选择采用并保存。仅补充不会使确认失效。
                  </p>
                  {draft?.candidateId && (
                    <p className="mb-3 text-sm text-amber-200">
                      候选的直接来源将由服务器核对，依赖来源完整保留。保存采用后可调整直接来源。
                    </p>
                  )}
                  {snapshot.evidence.map((e) => (
                    <div
                      key={e.id}
                      className="mb-4 border-b border-white/10 pb-4"
                    >
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          aria-label={`采用来源 ${e.id}`}
                          disabled={
                            busy ||
                            (!e.available &&
                              !draft?.evidenceIds.includes(e.id)) ||
                            snapshot.state !== "draft" ||
                            !draft ||
                            !!draft.candidateId ||
                            (draft.evidenceIds.length >= 64 &&
                              !draft.evidenceIds.includes(e.id))
                          }
                          checked={draft?.evidenceIds.includes(e.id) ?? false}
                          onChange={(x) =>
                            setDrafts({
                              ...drafts,
                              [selected]: {
                                ...draft,
                                evidenceIds: x.target.checked
                                  ? [...draft.evidenceIds, e.id]
                                  : draft.evidenceIds.filter((v) => v !== e.id),
                                editId: id(),
                                dirty: true,
                              },
                            })
                          }
                        />
                        <span className="break-all text-sm">
                          {e.available
                            ? JSON.stringify(e.payload)
                            : "此来源已受限"}
                          <span className="block text-xs text-zinc-500">
                            {e.kind} · {e.id}
                          </span>
                        </span>
                      </label>
                      {e.available && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            execute({
                              action: "restrictEvidence",
                              projectId: snapshot.projectId,
                              roundId: snapshot.roundId,
                              requestId: id(),
                              evidenceId: e.id,
                              deleted: true,
                              expiresAt: null,
                            })
                          }
                        >
                          限制此来源访问
                        </Button>
                      )}
                    </div>
                  ))}
                  <textarea
                    aria-label="用户来源补充"
                    className="w-full rounded border border-white/10 bg-black/20 p-3"
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    maxLength={20000}
                  />
                  <select
                    aria-label="修订来源"
                    className="my-3 max-w-full bg-zinc-900 p-2"
                    value={supersedes}
                    onChange={(e) => setSupersedes(e.target.value)}
                  >
                    <option value="">新增补充</option>
                    {snapshot.evidence.map((e) => (
                      <option key={e.id} value={e.id}>
                        修订 {e.id}
                      </option>
                    ))}
                  </select>
                  <Button
                    className="ml-3"
                    disabled={
                      busy || !evidence.trim() || snapshot.state !== "draft"
                    }
                    onClick={saveSource}
                  >
                    保存来源补充
                  </Button>
                </section>
                <section className={panel}>
                  <h3 className="mb-4 text-lg">轮次与正式版本</h3>
                  <div className="flex flex-wrap gap-2">
                    {rounds.map((r, i) => (
                      <Button
                        key={r.roundId}
                        variant="outline"
                        disabled={busy || dirty}
                        onClick={() =>
                          void run(() => load(snapshot.projectId, r.roundId))
                        }
                      >
                        {r.version
                          ? `正式 v${r.version}`
                          : `轮次 ${i + 1} · ${r.state === "draft" ? "草稿" : "已放弃"}`}
                      </Button>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button
                      disabled={
                        busy ||
                        dirty ||
                        currentProject?.workKind === "script" ||
                        snapshot.state === "draft" ||
                        rounds.some((r) => r.state === "draft")
                      }
                      onClick={() => start(undefined, snapshot.roundId)}
                    >
                      沿用此方法开启新轮次
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || dirty || snapshot.state !== "draft"}
                      onClick={() =>
                        execute({
                          action: "abandon",
                          projectId: snapshot.projectId,
                          roundId: snapshot.roundId,
                          requestId: id(),
                        })
                      }
                    >
                      放弃当前草稿
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () =>
                          setReport(
                            await api.report.query({
                              projectId: snapshot.projectId,
                              roundId: snapshot.roundId,
                            }),
                          ),
                        )
                      }
                    >
                      查看正式报告
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const value = await api.export.mutate({
                            projectId: snapshot.projectId,
                            roundId: snapshot.roundId,
                          });
                          const url = URL.createObjectURL(
                            new Blob([value.markdown], {
                              type: "text/markdown;charset=utf-8",
                            }),
                          );
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = value.filename;
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        })
                      }
                    >
                      重新校验并导出 Markdown
                    </Button>
                  </div>
                  <label className="mt-5 block">
                    与历史轮次比较
                    <select
                      aria-label="比较历史轮次"
                      className="ml-3 bg-zinc-900 p-2"
                      value={comparison?.roundId ?? ""}
                      disabled={busy}
                      onChange={(e) => {
                        const roundId = e.target.value;
                        if (roundId)
                          void run(async () => {
                            setComparison(
                              await api.read.query({
                                projectId: snapshot.projectId,
                                roundId,
                              }),
                            );
                          });
                        else setComparison(null);
                      }}
                    >
                      <option value="">请选择</option>
                      {rounds
                        .filter((r) => r.roundId !== snapshot.roundId)
                        .map((r, i) => (
                          <option key={r.roundId} value={r.roundId}>
                            {r.version
                              ? `正式 v${r.version}`
                              : `历史轮次 ${i + 1}`}
                          </option>
                        ))}
                    </select>
                  </label>
                  {comparison && (
                    <div className="mt-4">
                      <p className={label}>
                        仅比较保存内容；没有实践数据，不推断效果或原因。
                      </p>
                      {Array.from(
                        new Set([
                          ...comparison.workflow.steps.map((s) => s.id),
                          ...snapshot.workflow.steps.map((s) => s.id),
                        ]),
                      ).map((k) => (
                        <div key={k} className="mt-4">
                          <h4>
                            {snapshot.workflow.steps.find((s) => s.id === k)
                              ?.title ??
                              comparison.workflow.steps.find((s) => s.id === k)
                                ?.title}
                          </h4>
                          <p className={label}>
                            {!comparison.steps[k]
                              ? "新增步骤"
                              : !snapshot.steps[k]
                                ? "已移除步骤"
                                : comparison.steps[k].body ===
                                    snapshot.steps[k].body
                                  ? "正文无变化"
                                  : "正文已变化"}
                          </p>
                          <div className="grid gap-3 md:grid-cols-2">
                            <pre className="whitespace-pre-wrap break-words rounded bg-black/20 p-3">
                              历史：
                              {comparison.steps[k]?.body ?? "新增 / 不可用"}
                            </pre>
                            <pre className="whitespace-pre-wrap break-words rounded bg-black/20 p-3">
                              当前：{snapshot.steps[k]?.body ?? "删除 / 不可用"}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {report && (
                    <div className="mt-6">
                      {report.available && report.report ? (
                        <>
                          <h4 className="text-xl">
                            {report.report.title} · v{report.version}
                          </h4>
                          {currentProject?.workKind !== "script" && snapshot.workflow.kind === "social" && <ReportWorkActions report={report} />}
                          {report.report.sections.map((s, i) => (
                            <section key={i} className="mt-4">
                              <h5 className="text-amber-200">{s.title}</h5>
                              <p className="whitespace-pre-wrap break-words leading-7">
                                {s.body}
                              </p>
                            </section>
                          ))}
                          <pre className="mt-4 whitespace-pre-wrap break-words text-xs">
                            {JSON.stringify(report.report.sources, null, 2)}
                          </pre>
                          <p className={`mt-4 ${label}`}>
                            报告仅汇编已确认内容及来源，没有新的模型分析。
                          </p>
                        </>
                      ) : (
                        <p>
                          报告不可用：
                          {report.reason === "NOT_PUBLISHED"
                            ? "尚未发布"
                            : "来源已受限"}
                        </p>
                      )}
                    </div>
                  )}
                </section>
                {currentProject?.workKind !== "script" && snapshot.state !== "draft" &&
                  !rounds.some((r) => r.state === "draft") && (
                    <section className={panel}>
                      <h3>明确升级方法</h3>
                      <p className={`my-3 ${label}`}>
                        默认新轮次沿用原方法。升级会按实际资源与依赖变化使相关确认待复核，旧成果保持原版本。
                      </p>
                      <select
                        aria-label="升级方法"
                        className="bg-zinc-900 p-2"
                        value={upgrade}
                        onChange={(e) => setUpgrade(e.target.value)}
                      >
                        <option value="">选择新方法版本</option>
                        {catalog
                          .filter(
                            (c) =>
                              c.skillId === snapshot.skillId &&
                              c.moduleId === currentProject?.moduleId &&
                              (c.revisionId !== snapshot.revisionId ||
                                JSON.stringify(c.workflow) !==
                                  JSON.stringify(snapshot.workflow)),
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label} · 方法 v{c.workflow.version}
                            </option>
                          ))}
                      </select>
                      {newMethod && (
                        <>
                          <MethodDifference
                            before={snapshot.workflow}
                            after={newMethod.workflow}
                          />
                          <p className="my-3 break-all text-xs">
                            原包 {snapshot.packageHash}
                            <br />
                            新包 {newMethod.packageHash}
                          </p>
                          <Button
                            disabled={busy || dirty}
                            onClick={() => start(upgrade, snapshot.roundId)}
                          >
                            确认以上方法变化并新建轮次
                          </Button>
                        </>
                      )}
                    </section>
                  )}
              </>
            )}
            {!snapshot && !busy && (
              <section className={`${panel} py-16 text-center`}>
                <h2 className="text-xl">从一个项目开始</h2>
                <p className="mt-3 text-zinc-400">
                  选择已配置的方法，或重新打开已保存的项目。
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
function MethodDifference({
  before,
  after,
}: {
  before: PublicWorkflow;
  after: PublicWorkflow;
}) {
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      {[before, after].map((flow, i) => (
        <div key={i}>
          <p>
            {i ? "新方法" : "原方法"} · v{flow.version}
          </p>
          <pre className="whitespace-pre-wrap text-sm">
            {JSON.stringify(flow, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
