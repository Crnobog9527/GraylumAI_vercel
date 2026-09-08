/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/layout/AppHeader";
import { ReferenceContent } from "./reference-content";
import { SearchReferences } from "./search-references";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { saveVersionConflictMessage, candidateInvalidatedMessage, saveRoundClosedMessage } from "@repo/api/src/services/artifacts/public";
import type { ArtifactSnapshot } from "@repo/api/src/services/artifacts/public";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@repo/api/src/root";
type Chat = inferRouterOutputs<AppRouter>["workbench"]["chatRead"];
type Draft = {
  body: string;
  version: number;
  dirty: boolean;
  editId: string;
  candidateId?: string;
  evidenceIds: string[];
  provenanceIds: string[];
};
const id = () => crypto.randomUUID();
const surface =
  "rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4";
export function SkillConversation({
  conversationId,
  navigate,
}: {
  conversationId: string;
  navigate: (conversationId?: string) => void;
}) {
  const utils = trpc.useUtils(),
    api = utils.client.workbench;
  const [chat, setChat] = useState<Chat | null>(null),
    [snapshot, setSnapshot] = useState<ArtifactSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [inputs, setInputs] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [showSteps, setShowSteps] = useState(true);
  const [delivery, setDelivery] = useState<
    Parameters<typeof api.generate.mutate>[0] | null
  >(null);
  const [rounds, setRounds] = useState<
    inferRouterOutputs<AppRouter>["workbench"]["rounds"]
  >([]);
  const [sources, setSources] = useState<Record<string, string>>({}),
    [report, setReport] = useState<string | null>(null),
    [receipts, setReceipts] = useState<Record<string, string>>({});
  const alive = useRef(true),
    locked = useRef(false),
    pendingWrite = useRef<(() => Promise<void>) | null>(null),
    revision = useRef(0),
    inputRevision = useRef(0),
    autoSaveAttempt = useRef(""),
    pendingNavigation = useRef<(() => void) | null>(null),
    journalKey = useRef(""),
    journalReady = useRef(false),
    journalSaved = useRef(false),
    pendingSave = useRef<{ step: string; draft: Draft } | null>(null);
  const step = chat?.binding.stepId ?? "",
    draft = drafts[step],
    input = inputs[step] ?? "",
    source = sources[step] ?? "";
  const dirty =
    Object.values(drafts).some((d) => d.dirty) ||
    Object.values(inputs).some(Boolean) ||
    Object.values(sources).some(Boolean);
  const state = useRef({ chat, snapshot, drafts, dirty });
  state.current = { chat, snapshot, drafts, dirty };
  function setInput(value: string | ((old: string) => string)) {
    inputRevision.current++;
    setInputs((old) => ({
      ...old,
      [step]: typeof value === "function" ? value(old[step] ?? "") : value,
    }));
  }
  function setSource(value: string | ((old: string) => string)) {
    setSources((old) => ({
      ...old,
      [step]: typeof value === "function" ? value(old[step] ?? "") : value,
    }));
  }
  async function finishNavigation(next: string) {
    if (!alive.current) return;
    if (state.current.dirty) {
      setError("新方案已准备好。请先处理当前未保存内容，再从历史版本打开。");
      await reload();
      return;
    }
    navigate(next);
  }
  const scope = snapshot
    ? { projectId: snapshot.projectId, roundId: snapshot.roundId }
    : null;
  const storage = scope
    ? `workbench-receipts:${scope.projectId}:${scope.roundId}`
    : "";
  useEffect(() => {
    alive.current = true;
    setShowSteps(window.matchMedia("(min-width: 1024px)").matches);
    void (async () => {
      const { data } = await createClient().auth.getUser();
      if (!data.user || !alive.current) return;
      journalKey.current = `skill-draft:${data.user.id}:${conversationId}`;
      await reload();
    })().catch((e) => {
      if (alive.current)
        setError(e instanceof Error ? e.message : "恢复对话失败");
    });
    return () => {
      alive.current = false;
      revision.current++;
    };
  }, []);
  useLayoutEffect(() => {
    if (!journalReady.current || !journalKey.current || !snapshot) return;
    try {
      sessionStorage.setItem(journalKey.current, JSON.stringify({ projectId: snapshot.projectId,
        roundId: snapshot.roundId, drafts, inputs, sources, pendingSave: pendingSave.current }));
      journalSaved.current = true;
    } catch { journalSaved.current = false; }
  }, [drafts, inputs, sources, snapshot, busy]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (e: BeforeUnloadEvent) => { if (!journalSaved.current || busy) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    const guard = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.download ||
        anchor.protocol === "blob:"
      )
        return;
      if (anchor.href !== window.location.href) {
        if (!busy && journalSaved.current) return;
        event.preventDefault();
        event.stopPropagation();
        if (Object.values(inputs).some(Boolean) || Object.values(sources).some(Boolean)) {
          setError("有未发送的消息或未提交的参考资料，请先发送或清空。");
        } else {
          pendingNavigation.current = () => window.location.assign(anchor.href);
        }
      }
    };
    document.addEventListener("click", guard, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guard, true);
    };
  }, [dirty, busy, inputs, sources]);
  useEffect(() => {
    if (error) pendingNavigation.current = null;
    if (!dirty && !busy && pendingNavigation.current) {
      const next = pendingNavigation.current;
      pendingNavigation.current = null;
      next();
    }
  }, [dirty, busy, error]);
  useEffect(() => {
    if (!storage) return;
    try {
      const stored = JSON.parse(sessionStorage.getItem(storage) ?? "{}");
      if (stored && typeof stored === "object")
        setReceipts(
          Object.fromEntries(
            Object.entries(stored).filter(
              ([k, v]) =>
                /^[a-f0-9-]{36}$/.test(k) &&
                typeof v === "string" &&
                v.length <= 200000,
            ),
          ) as Record<string, string>,
        );
      const pending = JSON.parse(
        sessionStorage.getItem(storage + ":pending") ?? "null",
      );
      if (
        pending?.projectId === scope?.projectId &&
        pending?.roundId === scope?.roundId &&
        pending?.conversationId === conversationId
      )
        setDelivery(pending);
    } catch {}
  }, [storage]);
  async function reload() {
    const epoch = ++revision.current;
    const next = await api.chatRead.query({ conversationId });
    const [snap, history] = await Promise.all([
      api.read.query({
        projectId: next.binding.projectId,
        roundId: next.binding.roundId,
      }),
      api.rounds.query({ projectId: next.binding.projectId }),
    ]);
    if (!alive.current || epoch !== revision.current) return;
    setReport(null);
    setChat(next);
    setSnapshot(snap);
    setRounds(history);
    let recovered: Record<string, Draft> = {};
    if (!journalReady.current && journalKey.current) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(journalKey.current) ?? "null");
        if (saved?.projectId === snap.projectId && saved?.roundId === snap.roundId) {
          for (const [k, d] of Object.entries(saved.drafts ?? {}) as [string, Draft][]) {
            if (snap.steps[k] && d?.dirty === true && typeof d.body === "string" && d.body.length <= 20000 &&
                Number.isSafeInteger(d.version) && d.version >= 0 && typeof d.editId === "string" && /^[a-f0-9-]{36}$/.test(d.editId) &&
                Array.isArray(d.provenanceIds) && d.provenanceIds.length <= 2048 && d.provenanceIds.every(x => typeof x === "string") &&
                Array.isArray(d.evidenceIds) && d.evidenceIds.length <= 64 && d.evidenceIds.every(x => typeof x === "string") &&
                (d.candidateId === undefined || (typeof d.candidateId === "string" && /^[a-f0-9-]{36}$/.test(d.candidateId)))) recovered[k] = d;
          }
          const frozen = saved.pendingSave;
          if (frozen && recovered[frozen.step] && frozen.draft?.editId &&
              typeof frozen.draft.body === "string" && frozen.draft.body.length <= 20000 &&
              Number.isSafeInteger(frozen.draft.version) && frozen.draft.version >= 0 &&
              /^[a-f0-9-]{36}$/.test(frozen.draft.editId) &&
              Array.isArray(frozen.draft.provenanceIds) && frozen.draft.provenanceIds.length <= 2048 && frozen.draft.provenanceIds.every((x: unknown) => typeof x === "string") &&
              Array.isArray(frozen.draft.evidenceIds) && frozen.draft.evidenceIds.length <= 64 &&
              frozen.draft.evidenceIds.every((x: unknown) => typeof x === "string") &&
              (frozen.draft.candidateId === undefined || /^[a-f0-9-]{36}$/.test(frozen.draft.candidateId))) {
            pendingSave.current = { step: frozen.step, draft: frozen.draft };
          }
          const texts = (values: Record<string, unknown> | undefined, max: number) => Object.fromEntries(
            Object.entries(values ?? {}).filter(([k, v]) => !!snap.steps[k] && typeof v === "string" && v.length <= max));
          setInputs(texts(saved.inputs, 2000) as Record<string, string>);
          setSources(texts(saved.sources, 20000) as Record<string, string>);
        }
      } catch {}
      journalReady.current = true;
    }
    const visible = (d: Draft, k: string) => snap.steps[k]?.available !== false &&
      [...d.evidenceIds, ...d.provenanceIds].every(id => snap.evidence.some(e => e.id === id && e.available)) &&
      (!d.candidateId || snap.candidates.some(c => c.id === d.candidateId && c.stepId === k && c.body !== null));
    if (pendingSave.current && !visible(pendingSave.current.draft, pendingSave.current.step)) {
      // The authoritative read no longer permits this local text. Do not replay
      // restricted payloads even when the previous acknowledgement was unknown.
      pendingSave.current = null;
      pendingWrite.current = null;
    }
    const obsolete = (d: Draft) => snap.state !== "draft" || !!d.candidateId &&
      next.turns.some(t => t.summaryCandidateId === d.candidateId && t.summaryDismissed);
    // Hydrate the complete journal before resolving an unknown original save.
    // The existing serialized save queue alone recovers its immutable receipt.
    setDrafts((previous) => {
      const old = { ...recovered, ...previous };
      // Recover an already paid summary from server identity/basis, including
      // after another browser session. Never regenerate to recover its text.
      for (const turn of [...next.turns].reverse()) {
        if (snap.state !== "draft" || turn.summaryDismissed || turn.generationMode !== "dual" || turn.summaryState !== "succeeded" || !turn.summaryBasis || old[turn.stepId]?.dirty) continue;
        if (Object.entries(turn.summaryBasis).some(([key,basis]) => snap.steps[key]?.version !== basis.version || snap.steps[key]?.reviewVersion !== basis.reviewVersion)) continue;
        const candidate = snap.candidates.find(c => c.id === turn.summaryCandidateId);
        if (!candidate || candidate.body == null || candidate.directEvidenceIds == null || !visible({...old[turn.stepId],body:candidate.body,version:snap.steps[turn.stepId].version,dirty:true,editId:candidate.id,candidateId:candidate.id,evidenceIds:candidate.directEvidenceIds,provenanceIds:candidate.evidenceIds},turn.stepId)) continue;
        old[turn.stepId] = {body:candidate.body,version:snap.steps[turn.stepId].version,dirty:true,editId:candidate.id,candidateId:candidate.id,evidenceIds:candidate.directEvidenceIds,provenanceIds:candidate.evidenceIds};
      }
      return Object.fromEntries(
        Object.entries(snap.steps).map(([k, s]) => [
          k,
          old[k]?.dirty &&
          visible(old[k], k) && (!obsolete(old[k]) || pendingSave.current?.step === k)
            ? old[k]
            : {
                body: s.body ?? "",
                version: s.version,
                dirty: false,
                editId: id(),
                evidenceIds: s.evidenceIds,
                provenanceIds: s.provenanceIds,
              },
        ]),
      );
    });
    void utils.chat.getConversations.invalidate();
  }
  async function run(action: () => Promise<void>, recoverable = false) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    pendingWrite.current = recoverable ? action : null;
    try {
      await action();
      if (pendingWrite.current === action) pendingWrite.current = null;
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "操作未完成，请刷新状态。");
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function remember(requestId: string, receipt?: string) {
    // Persist outside React's updater: a response still belongs to this round
    // after navigation or unmount, even when React no longer renders this instance.
    const next: Record<string, string> = { ...receipts };
    try {
      const stored = JSON.parse(sessionStorage.getItem(storage) ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored)) {
          if (
            /^[a-f0-9-]{36}$/.test(key) &&
            typeof value === "string" &&
            value.length <= 200000
          )
            next[key] = value;
        }
      }
    } catch {}
    if (receipt) next[requestId] = receipt;
    else delete next[requestId];
    try {
      sessionStorage.setItem(storage, JSON.stringify(next));
    } catch {}
    if (alive.current) setReceipts(next);
  }
  function go(next?: string) {
    if (!busy && journalSaved.current) { navigate(next); return; }
    if (Object.values(inputs).some(Boolean) || Object.values(sources).some(Boolean)) {
      setError("有未发送的消息或未提交的参考资料，请先发送或清空。");
      return;
    }
    if (dirty || busy) {
      pendingNavigation.current = () => navigate(next);
      return;
    }
    navigate(next);
  }
  async function save(k: string, d: Draft) {
    if (!scope || locked.current) return;
    const command = {
      ...scope, requestId: d.editId, stepId: k,
      expectedVersion: d.version, body: d.body,
      ...(d.candidateId
        ? { action: "saveCandidate" as const, candidateId: d.candidateId }
        : { action: "save" as const, evidenceIds: d.evidenceIds }),
    };
    pendingSave.current = { step: k, draft: d };
    await run(async () => {
      try { await api.execute.mutate(command); }
      catch (error) {
        // These precise server responses are emitted only after an explicit rejected
        // write, with no saved request receipt. Unknown/network errors keep A frozen.
        if (error instanceof Error && (error as { data?: { code?: string } }).data?.code === "CONFLICT" &&
            [saveVersionConflictMessage, candidateInvalidatedMessage, saveRoundClosedMessage].includes(error.message)) {
          pendingSave.current = null;
          pendingWrite.current = null;
          await reload().catch(() => undefined);
        }
        throw error;
      }
      pendingSave.current = null;
      if (alive.current) setDrafts(old => {
        const current = old[k];
        if (!current || current.version !== d.version) return old;
        return { ...old, [k]: { ...current, version: d.version + 1,
          dirty: current.editId !== d.editId,
          candidateId: current.candidateId === d.candidateId ? undefined : current.candidateId } };
      });
      await reload();
    }, true);
  }
  useEffect(() => {
    if (busy || !scope || !snapshot || (snapshot.state !== "draft" && !pendingSave.current) || pendingWrite.current) return;
    if (pendingSave.current) {
      const saved = pendingSave.current;
      if (autoSaveAttempt.current !== saved.draft.editId) {
        autoSaveAttempt.current = saved.draft.editId;
        void save(saved.step, saved.draft);
      }
      return;
    }
    const pending = Object.entries(drafts).find(([k, d]) => d.dirty &&
      d.version === snapshot.steps[k]?.version && d.editId !== autoSaveAttempt.current);
    if (!pending) return;
    const [k, d] = pending;
    const timer = window.setTimeout(() => {
      if (locked.current) return;
      autoSaveAttempt.current = d.editId;
      void save(k, d);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [drafts, busy, snapshot]);
  async function send() {
    if (!scope || !snapshot || !input.trim()) return;
    if (Object.values(state.current.drafts).some(d => d.dirty)) { setError("请等待成果自动保存后再发送。"); return; }
    const body = input.trim(),
      selected = step,
      inputEpoch = inputRevision.current;
    const prior = chat?.turns
      .filter(
        (t) =>
          t.generationMode === "dual" &&
          t.stepId === selected &&
          t.body === body &&
          !t.candidateId &&
          !t.abandoned &&
          !snapshot.generations?.some((g) => g.requestId === t.requestId),
      )
      .at(-1);
    const requestId = prior?.requestId ?? id();
    await run(async () => {
      if (Object.values(state.current.drafts).some(d => d.dirty)) {
        // This send callback has not started any new request. Release only its
        // queue ownership so autosave can run; delivery/save identities survive.
        pendingWrite.current = null;
        throw new Error("请等待成果自动保存后再发送。");
      }
      await api.chatSubmit.mutate({
        conversationId,
        requestId,
        stepId: selected,
        body,
      });
      const expectedSteps = Object.fromEntries(
        Object.entries(snapshot.steps).map(([k, s]) => [
          k,
          { version: s.version, reviewVersion: s.reviewVersion },
        ]),
      );
      const value = {
        ...scope,
        conversationId,
        turnId: requestId,
        purpose: "reply" as const,
        stepId: selected,
        instruction: body,
        expectedSteps,
      };
      let q;
      try {
        q = await api.generationQuote.mutate(value);
      } catch (error) {
        // A rejected read-only quote must not pin future sends to stale frozen
        // context. The existing SQL tombstone refuses any reserved/dispatched ID.
        const cancelled = await api.abandonGeneration.mutate({ ...scope, requestId })
          .catch(() => ({ abandoned: false }));
        if (cancelled.abandoned) pendingWrite.current = null;
        await reload().catch(() => undefined);
        throw error;
      }
      if (!alive.current || inputRevision.current !== inputEpoch ||
          state.current.chat?.binding.stepId !== selected ||
          Object.values(state.current.drafts).some(d => d.dirty)) {
        // Editing while admission is pending cancels this intent before dispatch.
        // Tombstone it so it cannot later enter history/context as a sent message.
        await api.abandonGeneration.mutate({ ...scope, requestId });
        await reload();
        return;
      }
      // The Send click authorizes this message. Pricing stays server-controlled;
      // no amount is shown or accepted as a separate user interaction.
      await deliver({ ...value, requestId, quoteHash: q.quoteHash,
        budgetCredits: q.reservedCredits });
      await reload();
    }, true);
  }
  function rememberDelivery(
    value: Parameters<typeof api.generate.mutate>[0] | null,
  ) {
    try {
      if (value)
        sessionStorage.setItem(storage + ":pending", JSON.stringify(value));
      else sessionStorage.removeItem(storage + ":pending");
    } catch {}
    if (alive.current) setDelivery(value);
  }
  async function deliver(value: Parameters<typeof api.generate.mutate>[0]) {
    const known = state.current.snapshot?.generations?.find(g => g.requestId === value.requestId);
    if (Object.values(state.current.drafts).some(d => d.dirty) && (!known || known.state === "prepared")) {
      // This call could still dispatch. Release only the callback queue so the
      // edits can save; preserve the original delivery and receipt identities.
      pendingWrite.current = null;
      throw new Error("请等待成果自动保存后再恢复发送。");
    }
    rememberDelivery(value);
    let status;
    try {
      status = await api.generate.mutate(value);
    } catch (error) {
      // An absent request must be tombstoned before allowing a replacement.
      const result = await api.abandonGeneration
        .mutate({ ...scope!, requestId: value.requestId })
        .catch(() => ({ abandoned: false }));
      if (result.abandoned) {
        rememberDelivery(null);
        pendingWrite.current = null;
      }
      await reload().catch(() => undefined);
      throw error;
    }
    if (status.recoveryReceipt)
      remember(status.requestId, status.recoveryReceipt);
    else if (status.state === "succeeded" || status.state === "refunded")
      remember(status.requestId);
    if (alive.current) {
      setInputs((old) => ({
        ...old,
        [value.stepId]:
          (old[value.stepId] ?? "").trim() === value.instruction
            ? ""
            : (old[value.stepId] ?? ""),
      }));
    }
    await reload();
    await applyGeneratedResult(value, status);
    if (status.state === "succeeded" || status.state === "refunded") rememberDelivery(null);
    if (value.purpose === "reply" && status.state === "succeeded") {
      pendingWrite.current = null;
      await summarize(value.turnId!);
    }
  }
  async function summarize(turnId: string) {
    if (!scope || Object.values(state.current.drafts).some(d => d.dirty)) throw new Error("请等待成果自动保存后再整理。");
    const binding = await api.chatSummary.mutate({conversationId, requestId: turnId});
    const latest = await api.read.query(scope);
    const value = {...scope, conversationId, turnId, purpose: "summary" as const,
      stepId: binding.stepId, instruction: binding.body,
      expectedSteps: Object.fromEntries(Object.entries(latest.steps).map(([k,s]) => [k,{version:s.version,reviewVersion:s.reviewVersion}]))};
    const quote = await api.generationQuote.mutate(value);
    await deliver({...value, requestId:binding.requestId, quoteHash:quote.quoteHash, budgetCredits:quote.reservedCredits});
  }
  async function applyGeneratedResult(value: Parameters<typeof api.generate.mutate>[0],
    status: { state: string; candidateId: string | null }) {
    if (value.purpose !== "reply" && status.state === "succeeded" && status.candidateId) {
      const latest = await api.read.query({ projectId: value.projectId, roundId: value.roundId });
      if (value.purpose === "summary" && value.conversationId) {
        const authoritativeChat = await api.chatRead.query({conversationId:value.conversationId});
        if (authoritativeChat.turns.some(t => t.summaryCandidateId === status.candidateId && t.summaryDismissed)) return;
      }
      const candidate = latest.candidates.find(c => c.id === status.candidateId);
      const expectedVersion = value.expectedSteps[value.stepId]?.version;
      if (alive.current && latest.state === "draft" && candidate?.body != null && candidate.directEvidenceIds != null && latest.steps[value.stepId]?.version === expectedVersion) {
        const body = candidate.body;
        setDrafts(old => {
          const current = old[value.stepId];
          if (!current || current.dirty || current.version !== expectedVersion) return old;
          return { ...old, [value.stepId]: { ...current, body,
            candidateId: candidate.id, evidenceIds: candidate.directEvidenceIds!, provenanceIds: candidate.evidenceIds,
            dirty: true, editId: candidate.id } };
        });
      }
    }
  }
  const unresolved = snapshot?.generations?.some((g) =>
    ["prepared", "dispatched", "responded", "unknown"].includes(g.state),
  );
  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <AppHeader />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ChatSidebar
          activeConversationId={conversationId}
          onSelectConversation={go}
          onNewChat={reason => reason === 'deleted' ? navigate() : go()}
        />
        <main className="flex min-w-0 flex-1 flex-col" aria-label="Skill 对话">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] p-4">
            <div>
              <h1 className="font-semibold">
                {snapshot?.workflow.report.title ?? "正在恢复 Skill 对话"}
              </h1>
              <p className="text-sm text-[var(--text-tertiary)]">
                {snapshot?.workflow.steps.find((s) => s.id === step)?.title} ·
                成果自动保存，确认后进入下一步
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowSteps((v) => !v)}
              aria-expanded={showSteps}
            >
              步骤与成果
            </Button>
          </header>
          {error && (
            <div role="alert" className="px-4 py-2 text-amber-400">
              {error}
              {pendingWrite.current && (
                <Button
                  disabled={busy}
                  onClick={() => void run(pendingWrite.current!, true)}
                >
                  恢复原操作
                </Button>
              )}
            </div>
          )}
          <div
            className="min-h-0 flex-1 overflow-y-auto p-4"
            aria-label="当前步骤讨论"
          >
            {!chat?.turns.some((t) => t.stepId === step) && (
              <p className="mx-auto mt-12 max-w-lg text-[var(--text-tertiary)]">
                在这里补充需求、回答追问或要求修改。右侧可查看当前步骤成果，AI
                不会自动确认或发布。
              </p>
            )}
            {chat?.turns
              .filter((t) => t.stepId === step)
              .map((t) => (
                <article
                  key={t.requestId}
                  className="mx-auto mb-6 max-w-3xl space-y-3"
                >
                  <div
                    className={`${surface} ml-8`}
                    data-testid="chat-message"
                    data-message-role="user"
                  >
                    <p className="mb-2 text-xs text-[var(--text-tertiary)]">
                      你
                      {t.abandoned
                        ? " · 未发送，未扣费"
                        : t.generationState === "unsent"
                          ? " · 尚未发送"
                          : ""}
                    </p>
                    <p className="whitespace-pre-wrap break-words">
                      {t.available ? t.body : "来源已受限，内容不可用"}
                    </p>
                  </div>
                  {t.answer && t.available && (
                    <div
                      className={`${surface} mr-8`}
                      data-testid="chat-message"
                      data-message-role="assistant"
                    >
                      <p className="mb-2 text-xs text-[var(--text-tertiary)]">
                        AI · 对话回复
                      </p>
                      <p className="whitespace-pre-wrap break-words">
                        {t.answer}
                      </p>

                    </div>
                  )}
                  {t.generationMode === "dual" && t.generationState === "succeeded" && t.summaryState !== "succeeded" && <div className="text-sm text-[var(--text-secondary)]">
                    <p>回复已保存，成果待整理。</p>
                    {(!t.summaryState || t.summaryState === "pending" || t.summaryState === "prepared" || t.summaryState === "refunded") && <Button disabled={busy || !!unresolved && t.summaryState !== "prepared"} onClick={() => void run(() => summarize(t.requestId))}>继续整理成果</Button>}
                    {t.summaryState === "unknown" && <p>整理结果待核对，请勿重新发送。</p>}
                  </div>}
                </article>
              ))}
          </div>
          <div className="shrink-0 border-t border-[var(--border-primary)] p-4">
            <textarea
              aria-label="给当前步骤发消息"
              disabled={!snapshot}
              className="max-h-40 w-full resize-y rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"
              rows={3}
              maxLength={2000}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              placeholder="补充需求，或告诉 AI 需要怎样修改…"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  busy ||
                  !input.trim() ||
                  !!unresolved ||
                  !!delivery ||
                  Object.values(drafts).some(d => d.dirty) ||
                  snapshot?.state !== "draft"
                }
                onClick={() => void send()}
              >
                {busy ? "正在发送…" : "发送"}
              </Button>
              {delivery && (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() => void run(() => deliver(delivery), true)}
                >
                  恢复原发送状态
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void run(reload)}
              >
                刷新状态
              </Button>
              {Object.values(drafts).some(d => d.dirty) && (
                <span className="text-sm">正在自动保存成果…</span>
              )}
            </div>
            {snapshot?.generations
              ?.filter((g) => g.stepId === step && g.state !== "succeeded")
              .map((g) => (
                <div key={g.requestId} className="mt-2 text-sm">
                  {receipts[g.requestId]
                    ? "已收到结果，待恢复保存"
                    : g.state === "unknown" || g.state === "dispatched"
                      ? "结果待核对，请勿重新发送"
                      : g.state === "prepared"
                        ? "已预留，尚未发送"
                        : g.state === "refunded"
                          ? "未发送，预留已退还"
                          : "结果已保存，待结算"}
                  {(g.state === "responded" || receipts[g.requestId]) && (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() =>
                        void run(async () => {
                          const recovered = await api.recoverGeneration.mutate({
                            ...scope!,
                            requestId: g.requestId,
                            recoveryReceipt: receipts[g.requestId],
                          });
                          remember(g.requestId);
                          await reload();
                          if (delivery?.requestId === g.requestId) {
                            await applyGeneratedResult(delivery, recovered);
                            if (recovered.state === "succeeded" || recovered.state === "refunded") rememberDelivery(null);
                          }
                        })
                      }
                    >
                      恢复已知结果
                    </Button>
                  )}
                  {g.state === "prepared" && (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() =>
                        void run(async () => {
                          await api.cancelGeneration.mutate({
                            ...scope!,
                            requestId: g.requestId,
                          });
                          await reload();
                        })
                      }
                    >
                      取消未发送请求
                    </Button>
                  )}
                </div>
              ))}
          </div>
        </main>
        {showSteps && snapshot && chat && (
          <aside
            aria-label="Skill 步骤与成果"
            className="fixed inset-y-16 right-0 z-30 w-[min(90vw,360px)] overflow-y-auto border-l border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 shadow-xl lg:static lg:z-auto lg:w-[340px] lg:shrink-0 lg:shadow-none"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">步骤与成果</h2>
              <Button
                className="lg:hidden"
                variant="ghost"
                onClick={() => setShowSteps(false)}
              >
                收起
              </Button>
            </div>
            <nav className="space-y-2">
              {snapshot.workflow.steps.map((s, i) => (
                <button
                  key={s.id}
                  disabled={busy}
                  aria-current={s.id === step ? "step" : undefined}
                  className={`block w-full rounded-lg border p-3 text-left ${s.id === step ? "border-amber-400" : "border-[var(--border-primary)]"}`}
                  onClick={() =>
                    void run(async () => {
                      await api.chatSelect.mutate({
                        conversationId,
                        stepId: s.id,
                      });
                      await reload();
                    })
                  }
                >
                  {i + 1}. {s.title}
                  <span className="block text-xs text-[var(--text-tertiary)]">
                    {drafts[s.id]?.dirty
                      ? "未保存"
                      : snapshot.steps[s.id].valid
                        ? "已确认"
                        : snapshot.steps[s.id].confirmationId
                          ? "待复核"
                          : "待确认"}
                  </span>
                </button>
              ))}
            </nav>
            {draft && (
              <section className="mt-5 space-y-3">
                <h3>本步骤成果</h3>
                <textarea
                  aria-label="当前步骤工作稿"
                  rows={7}
                  disabled={snapshot.state !== "draft"}
                  className="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"
                  value={draft.body}
                  maxLength={
                    snapshot.workflow.steps.find((s) => s.id === step)
                      ?.maxLength
                  }
                  onChange={(e) =>
                    setDrafts((old) => ({
                      ...old,
                      [step]: {
                        ...old[step],
                        body: e.target.value,
                        dirty: true,
                        editId: id(),
                      },
                    }))
                  }
                />
                <div className="flex flex-wrap gap-2">
                  <span role="status" className="self-center text-sm text-[var(--text-tertiary)]">
                    {draft.dirty ? ((error || (!busy && pendingSave.current)) ? "尚未保存，请重试" : "保存中…") : "已保存"}
                  </span>
                  {draft.dirty && (error || (!busy && pendingSave.current)) && <Button onClick={() => { if (pendingWrite.current) void run(pendingWrite.current, true); else if (pendingSave.current) void save(pendingSave.current.step, pendingSave.current.draft); else void save(step, draft); }} disabled={busy}>重试保存</Button>}
                  <Button
                    disabled={
                      busy ||
                      draft.dirty ||
                      snapshot.state !== "draft" ||
                      snapshot.steps[step].valid ||
                      !draft.body.trim()
                    }
                    onClick={() => {
                      const cmd = {
                        action: "confirm" as const,
                        ...scope!,
                        requestId: id(),
                        stepId: step,
                        expectedVersion: snapshot.steps[step].version,
                        expectedReviewVersion:
                          snapshot.steps[step].reviewVersion,
                      };
                      void run(async () => {
                        await api.execute.mutate(cmd);
                        const confirmed = await api.read.query(scope!);
                        const position = confirmed.workflow.steps.findIndex(s => s.id === step);
                        const next = confirmed.workflow.steps.slice(position + 1).find(s =>
                          !confirmed.steps[s.id].valid && s.dependsOn.every(k => confirmed.steps[k].valid));
                        if (next) await api.chatSelect.mutate({ conversationId, stepId: next.id });
                        await reload();
                      }, true);
                    }}
                  >
                    {snapshot.workflow.steps.at(-1)?.id === step ? "确认本步骤成果" : "确认并进入下一步"}
                  </Button>
                </div>
                {draft.dirty &&
                  draft.version !== snapshot.steps[step].version && (
                    <div role="status" className="space-y-2 text-sm">
                      <p>服务器上的工作稿已更新，本地编辑仍保留。</p>
                      <pre className="whitespace-pre-wrap break-words">
                        {snapshot.steps[step].body ?? "来源不可用"}
                      </pre>
                      <Button
                        variant="outline"
                        disabled={busy || !!draft.candidateId}
                        onClick={() =>
                          setDrafts((old) => ({
                            ...old,
                            [step]: {
                              ...old[step],
                              version: snapshot.steps[step].version,
                              editId: id(),
                            },
                          }))
                        }
                      >
                        保留本地内容，采用最新保存版本
                      </Button>
                    </div>
                  )}
                {draft.dirty && (
                  <Button
                    variant="ghost"
                    disabled={busy || !!pendingSave.current}
                    onClick={() => void run(async () => {
                      if (draft.candidateId && chat?.turns.some(t => t.summaryCandidateId === draft.candidateId)) {
                        await api.chatDismissSummary.mutate({conversationId,candidateId:draft.candidateId});
                      }
                      setDrafts((old) => ({
                        ...old,
                        [step]: {
                          ...old[step],
                          body: snapshot.steps[step].body ?? "",
                          version: snapshot.steps[step].version,
                          evidenceIds: snapshot.steps[step].evidenceIds,
                          provenanceIds: snapshot.steps[step].provenanceIds,
                          candidateId: undefined,
                          dirty: false,
                          editId: id(),
                        },
                      }));
                      await reload();
                    }, true)}
                  >
                    放弃本地编辑并载入已保存内容
                  </Button>
                )}
              </section>
            )}
            {snapshot.candidates.some(
              (c) =>
                c.stepId === step &&
                !chat.turns.some((t) => t.candidateId === c.id),
            ) && (
              <details className="mt-5">
                <summary>此步骤的历史回复（只读）</summary>
                {snapshot.candidates
                  .filter(
                    (c) =>
                      c.stepId === step &&
                      !chat.turns.some((t) => t.candidateId === c.id),
                  )
                  .map((c) => (
                    <div key={c.id} className="my-3 space-y-2">
                      <p className="whitespace-pre-wrap break-words text-sm">
                        {c.body ?? "来源已受限，候选不可用"}
                      </p>

                    </div>
                  ))}
              </details>
            )}
            <details className="mt-5">
              <summary>参考资料（可选）</summary>
              <p className="my-2 text-sm text-[var(--text-tertiary)]">已关联的资料会随成果保留。你也可以选择已有资料或补充信息。</p>
              <SearchReferences key={`${snapshot.projectId}:${snapshot.roundId}:${step}`} projectId={snapshot.projectId} roundId={snapshot.roundId} stepId={step} disabled={busy || snapshot.state !== "draft" || !!pendingWrite.current || !!pendingSave.current} run={run} reload={reload} />
              {snapshot.evidence.map((e) => (
                <div key={e.id} className="mt-3 space-y-2 break-words text-sm">
                  <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={
                      busy ||
                      !!draft?.candidateId ||
                      snapshot.state !== "draft" ||
                      (!e.available && !draft?.evidenceIds.includes(e.id))
                    }
                    checked={draft?.evidenceIds.includes(e.id) ?? false}
                    onChange={(x) =>
                      setDrafts((old) => ({
                        ...old,
                        [step]: {
                          ...old[step],
                          evidenceIds: x.target.checked
                            ? [...old[step].evidenceIds, e.id]
                            : old[step].evidenceIds.filter((k) => k !== e.id),
                          dirty: true,
                          editId: id(),
                        },
                      }))
                    }
                  />
                  关联到本步骤
                  </label>
                  {e.available ? <ReferenceContent payload={e.payload} /> : "来源已受限"}
                </div>
              ))}
              <textarea
                aria-label="补充来源"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                maxLength={20000}
                className="mt-3 w-full bg-[var(--bg-secondary)] p-2"
              />
              <Button
                disabled={busy || !source.trim() || snapshot.state !== "draft"}
                onClick={() => {
                  const body = source,
                    cmd = {
                      action: "userEvidence" as const,
                      ...scope!,
                      requestId: id(),
                      body,
                      observedAt: null,
                      supersedes: null,
                    };
                  void run(async () => {
                    await api.execute.mutate(cmd);
                    if (alive.current)
                      setSource((old) => (old === body ? "" : old));
                    await reload();
                  }, true);
                }}
              >
                保存来源补充
              </Button>
            </details>
            <details className="mt-5">
              <summary>本步骤的确认记录</summary>
              {snapshot.confirmations
                .filter((c) => c.stepId === step)
                .map((c) => (
                  <p
                    className="mt-3 whitespace-pre-wrap break-words"
                    key={c.id}
                  >
                    确认 v{c.version}：{c.body ?? "来源受限"}
                  </p>
                ))}
            </details>
            <details className="mt-5">
              <summary>历史版本</summary>
              <p className="my-2 text-sm">
                查看之前的方案，或重新做一版；原有成果会保留。
              </p>
              {rounds.map((r, i) => (
                <Button
                  key={r.roundId}
                  variant="outline"
                  className="mb-2 mr-2"
                  disabled={busy || dirty || r.roundId === snapshot.roundId}
                  onClick={() => {
                    const requestId = id();
                    void run(async () => {
                      const next = await api.chatEnter.mutate({
                        projectId: snapshot.projectId,
                        roundId: r.roundId,
                        requestId,
                      });
                      await finishNavigation(next.conversationId);
                    }, true);
                  }}
                >
                  方案 {i + 1} ·{" "}
                  {r.version
                    ? `正式 v${r.version}`
                    : r.state === "draft"
                      ? "进行中"
                      : "已放弃"}
                </Button>
              ))}
              <Button
                disabled={
                  busy || dirty || rounds.some((r) => r.state === "draft")
                }
                onClick={() => {
                  const requestId = id(),
                    roundId = id(),
                    projectId = snapshot.projectId,
                    fromRoundId = snapshot.roundId;
                  void run(async () => {
                    await api.start.mutate({
                      projectId,
                      roundId,
                      requestId,
                      fromRoundId,
                    });
                    const next = await api.chatEnter.mutate({
                      projectId,
                      roundId,
                      requestId,
                    });
                    await finishNavigation(next.conversationId);
                  }, true);
                }}
              >
                重新做一版
              </Button>
            </details>
            <details className="mt-5">
              <summary>正式版本与报告</summary>
              <p className="my-2 text-sm">
                当前正式 v{snapshot.currentVersion}。对话不会自动发布。
              </p>
              <Button
                disabled={
                  busy ||
                  Object.values(drafts).some((d) => d.dirty) ||
                  snapshot.state !== "draft" ||
                  !Object.values(snapshot.steps).every((s) => s.valid)
                }
                onClick={() => {
                  const cmd = {
                    action: "publish" as const,
                    ...scope!,
                    requestId: id(),
                    expectedSteps: Object.fromEntries(
                      Object.entries(snapshot.steps).map(([k, s]) => [
                        k,
                        { version: s.version, reviewVersion: s.reviewVersion },
                      ]),
                    ),
                  };
                  void run(async () => {
                    const current = await api.read.query(scope!);
                    if (
                      current.state === "draft" &&
                      Object.values(state.current.drafts).some((d) => d.dirty)
                    )
                      throw new Error("请先保存或放弃新的工作稿，再恢复发布。");
                    await api.execute.mutate(cmd);
                    await reload();
                  }, true);
                }}
              >
                发布已确认版本
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api.export.mutate(scope!);
                    if (alive.current) setReport(r.markdown);
                  })
                }
              >
                查看并校验正式报告
              </Button>
              {report && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const latest = await api.export.mutate(scope!);
                        const blob = new Blob([latest.markdown], {
                            type: "text/markdown;charset=utf-8",
                          }),
                          url = URL.createObjectURL(blob),
                          a = document.createElement("a");
                        a.href = url;
                        a.download = "Skill报告.md";
                        a.click();
                        URL.revokeObjectURL(url);
                      })
                    }
                  >
                    下载已校验报告
                  </Button>
                  <pre className="mt-3 whitespace-pre-wrap break-words text-xs">
                    {report}
                  </pre>
                </>
              )}
            </details>
          </aside>
        )}
      </div>
    </div>
  );
}
