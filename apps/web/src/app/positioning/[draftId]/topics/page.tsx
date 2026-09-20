'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The bound topic workspace of one positioning draft.
 *
 * After the user explicitly agrees to continue past the confirmed positioning,
 * this page hosts a normal multi-turn Agent conversation. Everything that
 * matters is server-side: the confirmed positioning version the workspace is
 * bound to, the pinned method revision and its declared topic resources, the
 * dedicated Runtime Session, and the turn identity that authorizes spending.
 * A proposal only becomes a plan version through the existing save/adopt
 * transactions, so nothing here creates accounts, publishes content or spends
 * without an explicit user action.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Bot, Loader2, Send, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';
import { opcPlan, opcHandoff, opcTopicTurn } from '@repo/api/src/shared/opcRequests';

type PlanItem = {
  id: string;
  platform: string;
  account: string;
  title: string;
  brief: string;
  day: string;
};

type ChatRequest = { draftId: string; requestId: string; input: string };
type SaveRequest = { draftId: string; requestId: string; expectedVersion: number; sourceVersionId: string; body: PlanItem[] };
type AdoptRequest = { draftId: string; requestId: string; planId: string; accounts: Array<{ platform: string; account: string; expectedRevision: number | null }> };
type Operation = { kind: 'chat'; request: ChatRequest } | { kind: 'save'; request: SaveRequest } | { kind: 'adopt'; request: AdoptRequest };
// Only transaction-level definite rejections release a request. Unknown replies
// and identity conflicts retain the whole original envelope, never just its ID.
const definiteRejections = new Set(['OPC_VERSION_CONFLICT', 'OPC_ACCOUNT_CONFLICT', 'OPC_ACCOUNTS_INVALID', 'OPC_PLAN_INVALID', 'OPC_DUPLICATE_ITEM', 'OPC_SOURCE_DENIED', 'OPC_DENIED', 'OPC_TOPIC_SOURCE_REVOKED', 'OPC_TOPIC_UNBOUND', 'OPC_TOPIC_SKILL_MISSING']);

/** The last JSON array the Agent offered as the first-week plan, if any. */
function parseCandidate(text: string | null | undefined): PlanItem[] | null {
  if (!text) return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/g)].map(
    (m) => m[1],
  );
  const trimmed = text.trim();
  const bodies = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? [...blocks, trimmed]
    : blocks;
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(bodies[i]);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 28) continue;
      const items = parsed.map((raw) => {
        const item = raw as Record<string, unknown>;
        const value = (key: string) =>
          typeof item?.[key] === 'string' ? (item[key] as string).trim() : '';
        const candidate = {
          id: value('id'),
          platform: value('platform'),
          account: value('account'),
          title: value('title'),
          brief: value('brief'),
          day: value('day'),
        };
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id) ||
          !/^[a-z0-9_-]{1,32}$/.test(candidate.platform) ||
          !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(candidate.account) ||
          !candidate.title || candidate.title.length > 160 ||
          !candidate.brief || candidate.brief.length > 2000 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(candidate.day)
        )
          throw new Error('invalid item');
        return candidate;
      });
      return items;
    } catch {
      /* not this block */
    }
  }
  return null;
}

/** The user-facing text of a reply without the machine-readable plan block. */
function replyProse(text: string | null | undefined) {
  if (!text) return '正在核实结果，请保留本次对话。';
  return text.replace(/```(?:json)?\s*\[[\s\S]*?\]\s*```/g, '').trim() || text.trim();
}

export default function TopicWorkspacePage() {
  const params = useParams<{ draftId: string }>();
  const draftId = params?.draftId ?? '';
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Operation | null>(null);
  const operationBusy = useRef(false);
  const openingAttempt = useRef('');
  const [working, setWorking] = useState(false);
  const [candidate, setCandidate] = useState<{ body: PlanItem[]; requestId: string } | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [adopted, setAdopted] = useState<
    Array<{ projectId: string; workItemId: string; sessionId: string; itemId: string }>
  >([]);
  const end = useRef<HTMLDivElement>(null);

  const read = trpc.opc.read.useQuery({ draftId }, { enabled: Boolean(draftId) });
  const workspace = trpc.opc.topicWorkspace.useQuery(
    { draftId },
    { enabled: Boolean(draftId), refetchInterval: 30000 },
  );
  const sessionId = workspace.data?.bound ? workspace.data.sessionId : '';
  const view = trpc.runtime.view.useQuery(
    { sessionId },
    { enabled: Boolean(sessionId), refetchInterval: 5000 },
  );
  const bind = trpc.opc.consentTopicWorkspace.useMutation();
  const turn = trpc.opc.topicTurn.useMutation();
  const execute = trpc.runtime.execute.useMutation();
  const cancel = trpc.runtime.cancel.useMutation();
  const savePlan = trpc.opc.savePlan.useMutation();
  const handoff = trpc.opc.handoff.useMutation();

  const busy = working || turn.isPending || execute.isPending || bind.isPending || savePlan.isPending || handoff.isPending;
  const storageKey = sessionId ? 'opc-topic-operation:' + sessionId : '';
  const candidateKey = sessionId ? 'opc-topic-candidate:' + sessionId : '';
  useEffect(() => {
    if (!storageKey) return;
    const restore = () => {
      try {
        const raw = localStorage.getItem(storageKey);
        const op = raw ? JSON.parse(raw) as Operation : null;
        if (op && op.request.draftId !== draftId) throw new Error('wrong draft');
        setPending(op);
        const saved = localStorage.getItem(candidateKey);
        setCandidate(saved ? JSON.parse(saved) : null);
      } catch { setError('本机恢复记录无法读取，已停止新请求，请保留记录。'); }
    };
    restore();
    window.addEventListener('storage', restore);
    return () => window.removeEventListener('storage', restore);
  }, [storageKey, candidateKey, draftId]);
  function editCandidate(value: typeof candidate) {
    // Persist before changing the UI: refresh/re-login must not discard edits.
    if (!candidateKey) return;
    try {
      if (value) localStorage.setItem(candidateKey, JSON.stringify(value));
      else localStorage.removeItem(candidateKey);
      setCandidate(value);
    } catch { setError('无法保存本机草稿，已停止修改。'); }
  }

  const plans = (read.data?.plans ?? []) as Array<{
    planId: string;
    version: number;
    sourceVersionId: string;
    body: PlanItem[] | null;
  }>;
  const nextVersion = useMemo(
    () => plans.reduce((max, plan) => Math.max(max, plan.version), 0),
    [plans],
  );
  /**
   * Account identities come from the owned account list, not from the draft
   * read: `opc.read` for one draft has no accounts projection, so reading them
   * from there silently produced a null expected revision for every existing
   * account. The list carries the authoritative current revision.
   */
  const accountList = trpc.opc.list.useQuery();
  const accounts = (accountList.data?.accounts ?? []) as Array<{
    platform: string;
    account: string;
    revision: number;
  }>;

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [view.data?.executions?.length, busy]);

  const executions = view.data?.executions as
    | Array<{
        executionId: string;
        state: string;
        input: string | null;
        body: string | null;
        primaryBody: string | null;
        contentAvailable: boolean;
      }>
    | undefined;

  function failureMessage(cause: unknown) {
    const message = cause instanceof Error ? cause.message : '';
    if (message.includes('OPC_TOPIC_SKILL_MISSING'))
      return '当前定位方法没有声明可用的选题方法资源，无法开始选题工作对话。请联系管理员配置选题 Skill 后再继续；本次没有任何调用或花费。';
    if (message.includes('OPC_TOPIC_SOURCE_REVOKED'))
      return '这个工作空间绑定的定位版本已不可用，暂不能继续派发。原对话和成果仍然保留。';
    if (message.includes('OPC_TOPIC_BOUND') || message.includes('OPC_TOPIC_SOURCE_CHANGED'))
      return '这个草稿已经有绑定的选题工作空间，不能静默换到另一个版本。请继续使用原有工作空间。';
    if (message.includes('OPC_REQUEST_CONFLICT'))
      return '这条消息的原请求身份与现在的负载不一致，已停止发送。请读取原任务状态后再决定。';
    return '本次请求状态待核实。请使用「恢复原请求」读取原任务，不要重复发送相同内容。';
  }

  async function start() {
    setError('');
    const sourceVersionId = read.data?.report?.id;
    if (!sourceVersionId) return;
    try {
      const accepted = await bind.mutateAsync({ draftId, sourceVersionId });
      if (accepted.sourceVersionId !== sourceVersionId) throw new Error('OPC_TOPIC_SOURCE_CHANGED');
      await workspace.refetch();
    } catch (cause) { setError(failureMessage(cause)); }
  }

  async function perform(proposed: Operation) {
    if (!storageKey || operationBusy.current) return;
    operationBusy.current = true;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      // The browser lock prevents two tabs from replacing an unknown operation.
      await navigator.locks.request(storageKey, async () => {
        const raw = localStorage.getItem(storageKey);
        const op: Operation = raw ? JSON.parse(raw) : proposed;
        if (op.request.draftId !== draftId) throw new Error('OPC_REQUEST_CONFLICT');
        // Use the exact server schemas before freezing or dispatching. Even an
        // invalid pre-upgrade pending record can be released without guessing
        // whether a transport failure committed a valid business operation.
        const valid = op.kind === 'chat' ? opcTopicTurn.safeParse(op.request)
          : op.kind === 'save' ? opcPlan.safeParse(op.request)
          : op.kind === 'adopt' ? opcHandoff.safeParse(op.request) : null;
        if (!valid?.success) {
          if (raw) {
            localStorage.setItem(storageKey + ':invalid:' + op.request.requestId, raw);
            localStorage.removeItem(storageKey);
            setPending(null);
          }
          setError(op.kind === 'chat'
            ? '消息须为 1–8000 字，请修改后重试。本次未发送。'
            : '候选格式不完整：标题须为 1–160 字，简报须为 1–2000 字，请核对账号、日期和内容后重试。本次未发送。');
          return;
        }
        localStorage.setItem(storageKey, JSON.stringify(op));
        setPending(op);
        try {
          if (op.kind === 'chat') {
            const admitted = await turn.mutateAsync(op.request);
            await execute.mutateAsync({ executionId: admitted.executionId });
            setInput('');
          } else if (op.kind === 'save') {
            const result = await savePlan.mutateAsync(op.request);
            editCandidate(null);
            setNotice('已保存为第 ' + result.version + ' 版候选。请核对该版本后明确采纳。');
          } else {
            const result = await handoff.mutateAsync(op.request);
            setAdopted(result as typeof adopted);
            setNotice('已承接所选计划版本；进入对应工作项后可另行生成正文。');
          }
          localStorage.setItem(storageKey + ':completed:' + op.request.requestId, JSON.stringify(op));
          localStorage.removeItem(storageKey);
          setPending(null);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : '';
          if (definiteRejections.has(message)) {
            localStorage.setItem(storageKey + ':rejected:' + op.request.requestId, JSON.stringify(op));
            localStorage.removeItem(storageKey);
            setPending(null);
            setError('本次请求已明确拒绝（' + message + '），未提交此项修改。请核对刷新后的计划与账号，再明确重试。');
          } else setError(failureMessage(cause));
        }
        await Promise.all([read.refetch(), view.refetch(), accountList.refetch()]);
      });
    } catch (cause) { setError(failureMessage(cause)); }
    finally { operationBusy.current = false; setWorking(false); }
  }

  async function send() {
    if (!sessionId || !input.trim() || pending) return;
    await perform({ kind: 'chat', request: { draftId, requestId: crypto.randomUUID(), input: input.trim() } });
  }

  // Opening is authorized by the persisted consent, never by this page/URL.
  // All tabs recover the exact same ID/input. Existing conversations without
  // that consent remain passive until an explicit action.
  const opening = workspace.data?.opening as (ChatRequest & { executionId?: string | null }) | null | undefined;
  useEffect(() => {
    if (!opening || !sessionId || !view.data || busy || pending || !workspace.data?.sourceAllowed) return;
    if (openingAttempt.current === opening.requestId) return;
    const already = opening.executionId || view.data.executions?.some((e: { input?: string | null }) => e.input === opening.input);
    openingAttempt.current = opening.requestId;
    if (!already) void perform({ kind: 'chat', request: { draftId: opening.draftId, requestId: opening.requestId, input: opening.input } });
    // One attempt per mounted accepted intent; failures expose explicit recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening?.requestId, sessionId, view.data, pending, busy]);

  async function stop(executionId: string) {
    setError('');
    try {
      await cancel.mutateAsync({ executionId });
      await view.refetch();
    } catch {
      setError('取消状态待核实，请读取原任务。');
    }
  }

  async function recover(executionId: string) {
    setError('');
    try {
      await execute.mutateAsync({ executionId });
      await view.refetch();
    } catch {
      setError('暂时无法恢复，请保留原任务。');
    }
  }

  async function saveCandidate() {
    if (!candidate || pending) return;
    await perform({ kind: 'save', request: {
      draftId, requestId: candidate.requestId, expectedVersion: nextVersion,
      sourceVersionId: workspace.data?.sourceVersionId ?? '', body: candidate.body,
    } });
  }

  async function adopt(planId: string, body: PlanItem[]) {
    if (pending || accountList.isFetching || accountList.error || !accountList.data) return;
    const chosen = body.filter(item => selectedAccounts.includes(item.platform + '::' + item.account));
    const unique = new Map(chosen.map(item => [item.platform + '::' + item.account, item]));
    if (!unique.size) { setError('请先选择要承接的平台账号。'); return; }
    const plan = plans.find(value => value.planId === planId)!;
    if (chosen.length !== body.length || plan.version !== nextVersion) {
      // Preserve history and the atomic handoff contract: show the actual saved
      // subset/new version before the user explicitly adopts it.
      await perform({ kind: 'save', request: {
        draftId, requestId: crypto.randomUUID(), expectedVersion: nextVersion,
        sourceVersionId: plan.sourceVersionId, body: chosen,
      } });
      return;
    }
    await perform({ kind: 'adopt', request: {
      draftId, requestId: crypto.randomUUID(), planId,
      accounts: [...unique.values()].map(item => ({
        platform: item.platform, account: item.account,
        expectedRevision: accounts.find(a => a.platform === item.platform && a.account === item.account)?.revision ?? null,
      })),
    } });
  }

  if (read.isLoading || workspace.isLoading)
    return <main className="p-6">正在读取选题工作空间…</main>;
  if (read.error || workspace.error)
    return (
      <main className="p-6">
        <p role="alert">当前工作空间不可用，或你无权访问此定位草稿。</p>
        <Link className="underline" href={`/positioning/${draftId}`}>
          返回定位
        </Link>
      </main>
    );

  const bound = Boolean(workspace.data?.bound);
  const sourceAvailable = workspace.data?.sourceAllowed !== false;

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-y-auto bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-primary)] px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Link className="underline" href={`/positioning/${draftId}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="font-medium">第一周选题工作对话</h1>
            <p className="text-xs text-[var(--text-tertiary)]">
              {bound
                ? '绑定来源：已确认的正式定位版本 · 方法修订 ' +
                  (workspace.data?.revisionId ?? '').slice(0, 8) + ' · 正式定位 v' + workspace.data?.sourceVersion
                : '尚未开始'}
            </p>
          </div>
        </div>
        {bound && (
          <Link className="text-sm underline" href={`/positioning/${draftId}/plan`}>
            查看历史计划与承接
          </Link>
        )}
      </header>

      {!bound && (
        <section className="mx-auto w-full max-w-2xl p-6">
          <h2 className="text-lg font-semibold">开始第一周选题</h2>
          <p className="mt-3 text-sm text-[var(--text-secondary)]">
            确认定位不会自动生成选题。这里会创建一个绑定本次确认定位版本与你当前方法修订的工作对话；
            你可以反复对话、修改候选，之后再明确采纳。点击开始即同意使用 AI 生成首轮选题；生成与采纳独立。
          </p>
          {!read.data?.report?.available && (
            <p role="status" className="mt-3 text-sm">
              请先完成并确认正式定位，或保留原有已付费请求的恢复入口。
            </p>
          )}
          <Button className="mt-4" disabled={busy || !read.data?.report?.available} onClick={start}>
            开始选题工作对话
          </Button>
        </section>
      )}

      {bound && !sourceAvailable && (
        <p role="status" className="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 text-center text-sm">
          这个工作空间绑定的定位版本已不可用，暂不能继续派发新的请求；原对话、候选与承接记录仍然保留。
        </p>
      )}

      {bound && sourceAvailable && (
        <>
          <div className="min-h-64 flex-1 shrink-0 overflow-y-auto" aria-label="选题对话记录">
            {!executions?.length && (
              <div className="mx-auto flex min-h-48 max-w-xl flex-col items-center justify-center px-6 py-10 text-center">
                <Bot className="mb-3 h-8 w-8 text-[var(--color-primary)]" />
                <p className="text-sm text-[var(--text-tertiary)]">
                  {opening ? '正在恢复你已同意的首轮选题请求。' : '说一句你想先解决的问题，例如「先给我一版第一周选题，我再改」。'}
                </p>
              </div>
            )}
            <section className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
              <details className="text-sm">
                <summary>本次引用的正式定位 v{workspace.data?.sourceVersion}</summary>
                <pre className="whitespace-pre-wrap break-words">{JSON.stringify(workspace.data?.profile, null, 2)}</pre>
              </details>
              {executions?.map((e) => (
                <article key={e.executionId} className="space-y-3">
                  {e.input && (
                    <div className="flex justify-end gap-3">
                      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-secondary)] px-4 py-3 text-[var(--bg-primary)]">
                        {e.input}
                      </p>
                      <User className="mt-3 h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
                    </div>
                  )}
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--bg-primary)]">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 max-w-[85%] rounded-2xl rounded-bl-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3">
                      <p className="whitespace-pre-wrap break-words">
                        {e.contentAvailable ? replyProse(e.body ?? e.primaryBody) : '来源已不可用，暂不展示此内容。'}
                      </p>
                      {e.state === 'cost_pending' && (
                        <p role="status" className="mt-2 text-sm">
                          费用待核实；恢复只核对原调用。
                        </p>
                      )}
                      {e.state !== 'completed' && e.state !== 'cancelled' && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => recover(e.executionId)}>
                            恢复原任务
                          </Button>
                          <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => stop(e.executionId)}>
                            取消剩余执行
                          </Button>
                        </div>
                      )}
                      {e.state === 'completed' &&
                        (() => {
                          const body = parseCandidate(e.body ?? e.primaryBody);
                          if (!body) return null;
                          return (
                            <div>
                            <ul className="mt-3 space-y-2" aria-label="回复中的选题候选">
                              {body.map(item => <li key={item.id}><strong>{item.day} · {item.title}</strong><p>{item.platform}/{item.account} · {item.brief}</p></li>)}
                            </ul>
                            <Button
                              className="mt-3"
                              size="sm"
                              variant="outline"
                              disabled={busy || Boolean(pending)}
                              onClick={() => {
                                setNotice('');
                                editCandidate({ body, requestId: crypto.randomUUID() });
                              }}
                            >
                              把这条回复保存为候选版本
                            </Button>
                            </div>
                          );
                        })()}
                    </div>
                  </div>
                </article>
              ))}
              {pending && (
                <div className="rounded-xl border border-[var(--border-primary)] p-4">
                  <p role="status" className="text-sm">
                    上一项操作的结果尚未确认（完整原请求已冻结）。恢复会核对原消息、保存或采纳，不新建身份。
                  </p>
                  <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => perform(pending)}>
                    恢复原请求
                  </Button>
                </div>
              )}
              {busy && (
                <p role="status" className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]">
                  <Loader2 className="h-4 w-4 animate-spin" />正在处理，请稍候…
                </p>
              )}
              <div ref={end} />
            </section>
          </div>

          {candidate && (
            <section className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
              <div className="mx-auto max-w-4xl">
                <h2 className="text-sm font-medium">保存为候选版本</h2>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  将保存为第 {nextVersion + 1} 版，不会覆盖历史版本，也不会创建账号或生成正文。
                </p>
                <ul className="mt-2 max-h-40 overflow-y-auto text-sm" aria-label="候选选题">
                  {candidate.body.map((item) => (
                    <li key={item.id}>
                      {item.day} · {item.platform}/{item.account}
                      <select aria-label={'候选账号 ' + item.id} value={item.platform + '::' + item.account} disabled={Boolean(pending)} onChange={event => {
                        const [platform, account] = event.target.value.split('::');
                        editCandidate({ ...candidate, requestId: crypto.randomUUID(), body: candidate.body.map(row => row.id === item.id ? { ...row, platform, account } : row) });
                      }}>
                        <option value={item.platform + '::' + item.account}>{item.platform}/{item.account}</option>
                        {accounts.filter(a => a.platform !== item.platform || a.account !== item.account).map(a => <option key={a.platform + '::' + a.account} value={a.platform + '::' + a.account}>已有账号：{a.platform}/{a.account}</option>)}
                      </select>
                      <input aria-label={'选题标题 ' + item.id} value={item.title} disabled={Boolean(pending)} maxLength={160} onChange={event => editCandidate({ ...candidate, requestId: crypto.randomUUID(), body: candidate.body.map(row => row.id === item.id ? { ...row, title: event.target.value } : row) })} />
                      <Textarea aria-label={'选题简报 ' + item.id} value={item.brief} disabled={Boolean(pending)} maxLength={2000} onChange={event => editCandidate({ ...candidate, requestId: crypto.randomUUID(), body: candidate.body.map(row => row.id === item.id ? { ...row, brief: event.target.value } : row) })} />
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" disabled={busy || Boolean(pending)} onClick={saveCandidate}>
                    保存这一版候选
                  </Button>
                  <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => editCandidate(null)}>
                    放弃
                  </Button>
                </div>
              </div>
            </section>
          )}

          {(plans.length > 0 || adopted.length > 0) && (
            <section className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
              <div className="mx-auto max-w-4xl">
                <h2 className="text-sm font-medium">候选版本与承接</h2>
                {plans.map((plan) => (
                  <article key={plan.planId} className="mt-3 rounded-xl border border-[var(--border-primary)] p-3">
                    <h3 className="text-sm font-medium">第 {plan.version} 版 · {plan.body?.length ?? 0} 个选题</h3>
                    {plan.body ? (
                      <>
                        <ul className="mt-2 max-h-40 overflow-y-auto text-sm" aria-label={'第 ' + plan.version + ' 版选题'}>
                          {plan.body.map((item) => {
                            const key = item.platform + '::' + item.account;
                            return (
                              <li key={item.id} className="flex items-center gap-2">
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    aria-label={key}
                                    checked={selectedAccounts.includes(key)}
                                    onChange={(event) =>
                                      setSelectedAccounts((current) =>
                                        event.target.checked
                                          ? [...current, key]
                                          : current.filter((value) => value !== key),
                                      )
                                    }
                                  />
                                  {item.day} · {item.platform}/{item.account} · {item.title} · {accounts.some(a => a.platform === item.platform && a.account === item.account) ? '采用已有账号项目' : '创建账号项目（不注册外部账号）'}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                        <Button
                          className="mt-3"
                          size="sm"
                          disabled={busy || Boolean(pending) || accountList.isFetching || Boolean(accountList.error)}
                          onClick={() => adopt(plan.planId, plan.body as PlanItem[])}
                        >
                          {plan.version !== nextVersion || plan.body.some(item => !selectedAccounts.includes(item.platform + '::' + item.account)) ? '将所选账号保存为独立候选版本' : '按所选账号采纳这次计划'}
                        </Button>
                      </>
                    ) : (
                      <p role="status" className="mt-2 text-sm">
                        来源已不可用，暂不能采纳此版本。
                      </p>
                    )}
                  </article>
                ))}
                {(read.data?.handoffs?.flatMap((h: { result: typeof adopted }) => h.result) ?? adopted).map((item: typeof adopted[number]) => (
                  <p key={item.itemId} className="mt-2 text-sm">
                    已承接：
                    <Link className="underline" href={'/runtime?session=' + item.sessionId}>
                      进入该选题的工作空间
                    </Link>
                  </p>
                ))}
              </div>
            </section>
          )}

          <footer className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
            <div className="mx-auto max-w-3xl">
              <div className="flex items-end gap-2 rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 focus-within:border-[var(--color-primary)]">
                <Textarea
                  aria-label="消息"
                  placeholder="继续讨论、修改或要求生成第一周选题…"
                  value={input}
                  disabled={busy || Boolean(pending) || Boolean(view.data?.activeExecution)}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (!busy && !pending && input.trim() && !view.data?.activeExecution) void send();
                    }
                  }}
                  className="min-h-12 max-h-36 flex-1 resize-none border-0 bg-transparent px-2 focus-visible:ring-0"
                  rows={2}
                />
                <Button
                  aria-label="发送"
                  className="h-10 w-10 shrink-0 rounded-xl p-0"
                  disabled={busy || Boolean(pending) || !input.trim() || Boolean(view.data?.activeExecution)}
                  onClick={() => send()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <p className="mt-2 text-center text-xs text-[var(--text-tertiary)]">
                这个对话绑定已确认的定位版本与当前方法修订；生成候选和采纳账号是两次独立动作。
              </p>
            </div>
          </footer>
        </>
      )}

      {notice && (
        <p role="status" className="shrink-0 p-3 text-center text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="shrink-0 p-3 text-center text-sm">
          {error}
        </p>
      )}
    </main>
  );
}
