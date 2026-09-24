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
import { ArrowLeft, ArrowUp, Bot, Loader2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import composerStyles from '@/components/opc/work-composer.module.css';
import topicStyles from './topic-candidates.module.css';
import { trpc } from '@/trpc/client';
import { planItem, opcPlan, opcHandoff, opcTopicTurn, opcTopicDraft, opcAdoptTopics } from '@repo/api/src/shared/opcRequests';

type PlanItem = {
  id: string;
  platform: string;
  account: string;
  title: string;
  brief: string;
  day: string;
  contentType?: 'article'|'image_text'|'video'|'unknown';
};

type ChatRequest = { draftId: string; requestId: string; input: string };
type SaveRequest = { draftId: string; requestId: string; expectedVersion: number; sourceVersionId: string; body: PlanItem[] };
type AdoptRequest = { draftId: string; requestId: string; planId: string; accounts: Array<{ platform: string; account: string; expectedRevision: number | null }> };
type DraftRequest = SaveRequest & { executionId: string };
type AdoptTopicsRequest = SaveRequest & { accounts: Array<{ platform: string; account: string; expectedRevision: number | null }> };
type Operation = { kind: 'chat'; request: ChatRequest } | { kind: 'save'; request: SaveRequest } | { kind: 'adopt'; request: AdoptRequest } | { kind: 'draft'; request: DraftRequest } | { kind: 'adoptTopics'; request: AdoptTopicsRequest };
// Only transaction-level definite rejections release a request. Unknown replies
// and identity conflicts retain the whole original envelope, never just its ID.
const definiteRejections = new Set(['OPC_BUSINESS_CONFLICT', 'OPC_BUSINESS_DENIED', 'OPC_VERSION_CONFLICT', 'OPC_ACCOUNT_CONFLICT', 'OPC_ACCOUNTS_INVALID', 'OPC_PLAN_INVALID', 'OPC_DUPLICATE_ITEM', 'OPC_TOPIC_ALREADY_ADOPTED', 'OPC_SOURCE_DENIED', 'OPC_DENIED', 'OPC_TOPIC_SOURCE_REVOKED', 'OPC_TOPIC_UNBOUND', 'OPC_TOPIC_SKILL_MISSING']);

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
          ...(value('contentType')?{contentType:planItem.shape.contentType.parse(value('contentType'))} : {}),
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
  return text.replace(/```(?:json)?\s*(?:\[[\s\S]*?\]|\{[\s\S]*?\})\s*```/g, '').trim() || text.trim();
}

function parseAdoption(text: string | null | undefined): string[] | null {
  if (!text) return null;
  for (const match of [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].reverse()) {
    try {
      const value = JSON.parse(match[1]) as { action?: unknown; itemIds?: unknown };
      if (value.action === 'adopt' && Array.isArray(value.itemIds) && value.itemIds.length > 0 && value.itemIds.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) return [...new Set(value.itemIds as string[])];
    } catch { /* not an adoption block */ }
  }
  return null;
}

export default function TopicWorkspacePage() {
  const params = useParams<{ draftId: string }>();
  const draftId = params?.draftId ?? '';
  const [panelOpen,setPanelOpen]=useState(true);
  const [input, setInput] = useState('');
  const inputKey=draftId?'opc-topic-input:'+draftId:'';
  useEffect(()=>{if(inputKey)setInput(localStorage.getItem(inputKey)??'');},[inputKey]);
  function updateInput(value:string){setInput(value);if(inputKey)localStorage.setItem(inputKey,value);}
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Operation | null>(null);
  const operationBusy = useRef(false);
  const openingAttempt = useRef('');
  const [working, setWorking] = useState(false);
  const [candidate, setCandidate] = useState<{ body: PlanItem[]; requestId: string } | null>(null);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [adopted, setAdopted] = useState<
    Array<{ projectId: string; workItemId: string; sessionId: string; itemId: string }>
  >([]);
  const end = useRef<HTMLDivElement>(null);
  const persistedExecution = useRef('');
  const adoptedExecution = useRef('');

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
  const saveDraft = trpc.opc.saveTopicDraft.useMutation();
  const adoptTopics = trpc.opc.adoptTopics.useMutation();
  const topicDraft = trpc.opc.topicDraft.useQuery({ draftId }, { enabled: Boolean(draftId && sessionId) });

  const [candidateExpanded, setCandidateOpen] = useState<boolean | null>(null);
  const busy = working || turn.isPending || execute.isPending || bind.isPending || savePlan.isPending || handoff.isPending || saveDraft.isPending || adoptTopics.isPending;
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
  const selectionDraftVersion = useRef<string | null>(null);
  useEffect(() => {
    const body = topicDraft.data?.body as PlanItem[] | null | undefined;
    if (!body?.length) return;
    const requestId = topicDraft.data.draftVersionId ?? crypto.randomUUID();
    // Local corrections remain attached to the same server draft version.
    // A new Agent draft replaces them; a refresh of the same version does not.
    try {
      const local = candidateKey ? localStorage.getItem(candidateKey) : null;
      const edited = local ? JSON.parse(local) : null;
      setCandidate(edited?.requestId === requestId ? edited : { body, requestId });
    } catch { setError('本机候选修改无法读取，请保留记录。'); }

    if (selectionDraftVersion.current !== requestId) {
      selectionDraftVersion.current = requestId;
      setSelectedItems(body.map(item => item.id));
    }
  }, [topicDraft.data?.draftVersionId, topicDraft.data?.body, candidateKey]);

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
  const adoptedItemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const handoff of (read.data?.handoffs ?? []) as Array<{ result?: Array<{ itemId?: string }> }>)
      for (const item of handoff.result ?? []) if (item.itemId) ids.add(item.itemId);
    for (const item of adopted) ids.add(item.itemId);
    return ids;
  }, [read.data?.handoffs, adopted]);
  const handoffItems = [...(read.data?.handoffs??[]).flatMap((h:{result?:Array<{itemId:string;workItemId:string;sessionId:string}>})=>h.result??[]),...adopted];
  function topicLink(item:PlanItem){const saved=handoffItems.find((h:{itemId:string;sessionId:string})=>h.itemId===item.id);return saved?'/runtime?session='+saved.sessionId+'&continue=1':undefined;}
  const candidateOpen = candidateExpanded ?? !candidate?.body.some(item => adoptedItemIds.has(item.id));
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
          : op.kind === 'adopt' ? opcHandoff.safeParse(op.request)
          : op.kind === 'draft' ? opcTopicDraft.safeParse(op.request)
          : op.kind === 'adoptTopics' ? opcAdoptTopics.safeParse(op.request) : null;
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
            setInput(current=>{if(current===op.request.input){localStorage.removeItem(inputKey);return '';}return current;});
          } else if (op.kind === 'save') {
            const result = await savePlan.mutateAsync(op.request);
            editCandidate(null);
            setNotice('已保存为第 ' + result.version + ' 版候选。请核对该版本后明确采纳。');
          } else if (op.kind === 'adopt') {
            const result = await handoff.mutateAsync(op.request);
            setAdopted(result as typeof adopted);
            setCandidateOpen(false);
            setPanelOpen(false);
            setNotice('已采用所选内容并保存到资料库。');
          } else if (op.kind === 'draft') {
            const result = await saveDraft.mutateAsync(op.request);
            editCandidate({ body: result.body as PlanItem[], requestId: op.request.requestId });
            setSelectedItems((result.body as PlanItem[]).map(item => item.id));
          } else {
            const result = await adoptTopics.mutateAsync(op.request);
            setAdopted(result.items as typeof adopted);
            const acceptedIds = new Set((result.items as typeof adopted).map(item => item.itemId));
            setSelectedItems(current => current.filter(id => !acceptedIds.has(id)));
            setCandidateOpen(false);
            setPanelOpen(false);
            setNotice('已采用所选内容并保存到资料库。可从下方进入对应内容工作。');
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
            setError(message === 'OPC_BUSINESS_CONFLICT' ? '这个账号已属于另一项业务，本次没有采用。请展开选题，修改为当前业务的账号后再采用；原请求已保留。' : '本次请求已明确拒绝（' + message + '），未提交此项修改。请核对刷新后的计划与账号，再明确重试。');
          } else setError(failureMessage(cause));
        }
        await Promise.all([read.refetch(), view.refetch(), accountList.refetch(), topicDraft.refetch()]);
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

  function adoptionRequest(body: PlanItem[], itemIds: string[], requestId = crypto.randomUUID()): AdoptTopicsRequest | null {
    if (accountList.isFetching || accountList.error || !accountList.data) return null;
    const chosen = body.filter(item => itemIds.includes(item.id));
    const unique = new Map(chosen.map(item => [item.platform + '::' + item.account, item]));
    if (!chosen.length || !unique.size) return null;
    return {
      draftId, requestId, expectedVersion: nextVersion,
      sourceVersionId: workspace.data?.sourceVersionId ?? '', body: chosen,
      accounts: [...unique.values()].map(item => ({
        platform: item.platform, account: item.account,
        expectedRevision: accounts.find(a => a.platform === item.platform && a.account === item.account)?.revision ?? null,
      })),
    };
  }

  async function adoptCurrent(itemIds = selectedItems, requestId?: string) {
    if (!candidate || pending) return;
    const remaining = itemIds.filter(id => !adoptedItemIds.has(id));
    const request = adoptionRequest(candidate.body, remaining, requestId);
    if (!request) {
      setError(itemIds.some(id => adoptedItemIds.has(id))
        ? '所选选题已经采用并保存在资料库中，请选择尚未采用的选题。'
        : '请先选择要采用的具体选题。');
      return;
    }
    await perform({ kind: 'adoptTopics', request });
  }

  // Every completed Agent proposal is durably auto-saved as a draft version.
  // The execution id is also the stable save identity, so refresh, re-login and
  // two tabs converge on the same version instead of creating duplicate drafts.
  useEffect(() => {
    if (!executions || !workspace.data?.sourceVersionId || pending || busy || !topicDraft.data) return;
    const offered = [...executions].reverse().find(e => e.state === 'completed' && e.contentAvailable && parseCandidate(e.body ?? e.primaryBody));
    if (!offered || persistedExecution.current === offered.executionId) return;
    if (topicDraft.data.requestId === offered.executionId) {
      persistedExecution.current = offered.executionId;
      return;
    }
    const body = parseCandidate(offered.body ?? offered.primaryBody);
    if (!body) return;
    persistedExecution.current = offered.executionId;
    void perform({kind:'draft',request:{draftId,requestId:offered.executionId,executionId:offered.executionId,expectedVersion:topicDraft.data.version??0,sourceVersionId:workspace.data.sourceVersionId,body}});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executions, workspace.data?.sourceVersionId, topicDraft.data?.version, pending, busy]);

  // Clear natural-language adoption from the Agent uses the same atomic action
  // as the card. Vague agreement never produces the action block and is inert.
  useEffect(() => {
    if (!executions || !candidate || pending || busy || accountList.isFetching || !accountList.data || accountList.error) return;
    const action = [...executions].reverse().find(e => e.state === 'completed' && parseAdoption(e.body ?? e.primaryBody));
    if (!action || adoptedExecution.current === action.executionId) return;
    const alreadyAdopted = (read.data?.handoffs ?? []).some(
      (handoff: { requestId?: string }) => handoff.requestId === action.executionId,
    );
    if (alreadyAdopted) {
      adoptedExecution.current = action.executionId;
      return;
    }
    const ids = parseAdoption(action.body ?? action.primaryBody);
    if (!ids) return;
    const request = adoptionRequest(candidate.body, ids.filter(id => !adoptedItemIds.has(id)), action.executionId);
    if (!request) return;
    adoptedExecution.current = action.executionId;
    void perform({ kind: 'adoptTopics', request });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executions, candidate, pending, busy, read.data?.handoffs, accountList.data, accountList.isFetching, accountList.error]);

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
    <WorkspaceFrame area="topics" rightOpen={panelOpen} onToggleRight={()=>setPanelOpen(value=>!value)} right={<div className="h-full overflow-y-auto"><header className="border-b px-4 py-5 text-base font-medium">选题与版本</header>
          {candidate && topicDraft.data && (
            <section className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
              <div className="mx-auto max-w-4xl">
                <button type="button" className="flex w-full items-center justify-between text-sm font-medium" aria-expanded={candidateOpen} onClick={()=>setCandidateOpen(!candidateOpen)}><span>选题草稿 · {candidate.body.filter(item=>!adoptedItemIds.has(item.id)).length} 条未采用</span><span>{candidateOpen?'收起选题':'展开选题'}</span></button>
                {candidateOpen && <>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  选择具体选题后直接采用；也可以用自然语言告诉 Agent「采用全部」或「只采用第 1、3 条」。
                </p>
                <ul className="mt-2  text-sm" aria-label="候选选题">
                  {candidate.body.map((item) => {
                    const wasAdopted = adoptedItemIds.has(item.id);
                    return (
                    <li key={item.id} className="flex items-start gap-2 py-2">
                      <input type="checkbox" aria-label={'选择 '+item.title} disabled={wasAdopted||busy||Boolean(pending)} checked={!wasAdopted && selectedItems.includes(item.id)} onChange={event=>setSelectedItems(current=>event.target.checked?[...new Set([...current,item.id])]:current.filter(id=>id!==item.id))}/>
                      <span><strong>{item.day} · {topicLink(item)?<Link className="underline" href={topicLink(item)!}>{item.title}</Link>:item.title}</strong>{wasAdopted ? ' · 已采用' : ''}<br/><span className="text-xs text-[var(--text-tertiary)]">{item.platform}/{item.account} · {item.brief}</span>{!wasAdopted && <label className="block mt-2 text-xs">内容类型<select aria-label={'内容类型 '+item.title} value={item.contentType??'unknown'} disabled={busy||Boolean(pending)} onChange={event=>editCandidate({...candidate,body:candidate.body.map(row=>row.id===item.id?{...row,contentType:planItem.shape.contentType.parse(event.target.value)}:row)})} className="ml-2 rounded border bg-[var(--bg-primary)] p-1"><option value="unknown">待确认</option><option value="article">文章</option><option value="image_text">图文</option><option value="video">视频</option></select></label>}{!wasAdopted && <details className="mt-1"><summary className="cursor-pointer text-xs">修改平台或账号</summary><label className="block text-xs">平台<input aria-label={'平台 '+item.title} disabled={busy||Boolean(pending)} value={item.platform} onChange={event=>editCandidate({...candidate,body:candidate.body.map(row=>row.id===item.id?{...row,platform:event.target.value}:row)})} className="ml-2 rounded border bg-transparent px-2"/></label><label className="block text-xs">账号<input aria-label={'账号 '+item.title} disabled={busy||Boolean(pending)} value={item.account} onChange={event=>editCandidate({...candidate,body:candidate.body.map(row=>row.id===item.id?{...row,account:event.target.value}:row)})} className="ml-2 rounded border bg-transparent px-2"/></label></details>}</span>
                    </li>
                  );})}
                </ul>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" disabled={busy || Boolean(pending) || !selectedItems.some(id=>!adoptedItemIds.has(id))} onClick={()=>adoptCurrent()}>
                    采用所选并保存到资料库
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy || Boolean(pending) || candidate.body.every(item=>adoptedItemIds.has(item.id))} onClick={()=>setSelectedItems(candidate.body.filter(item=>!adoptedItemIds.has(item.id)).map(item=>item.id))}>
                    全选
                  </Button>
                </div>
                </>}
              </div>
            </section>
          )}

          {(plans.length > 0 || adopted.length > 0) && (
            <section className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
              <div className="mx-auto max-w-4xl">
                <details><summary className="cursor-pointer text-sm font-medium">历史正式采用版本 · {plans.length}</summary>{plans.map((plan) => (
                  <article key={plan.planId} className="mt-3 rounded-xl border border-[var(--border-primary)] p-3">
                    <h3 className="text-sm font-medium">第 {plan.version} 版 · {plan.body?.length ?? 0} 个选题</h3>
                    {plan.body ? (
                        <ul className="mt-2  text-sm" aria-label={'第 ' + plan.version + ' 版选题'}>
                          {plan.body.map((item) => <li key={item.id}>{item.day} · {item.platform}/{item.account} · {topicLink(item)?<Link className="underline" href={topicLink(item)!}>{item.title}</Link>:item.title}</li>)}
                        </ul>
                    ) : (
                      <p role="status" className="mt-2 text-sm">
                        来源已不可用，暂不能采纳此版本。
                      </p>
                    )}
                  </article>
                ))}</details>

              </div>
            </section>
          )}

          <details className="p-4"><summary>讨论中的候选记录</summary>{executions?.filter(e=>e.contentAvailable&&e.state==='completed').map(e=>{const rows=parseCandidate(e.body??e.primaryBody);return rows?<article key={e.executionId} className="border-t py-3"><ul>{rows.map(item=><li key={item.id} className="py-2"><strong>{topicLink(item)?<Link href={topicLink(item)!} className="underline">{item.title}</Link>:item.title}</strong><p className="text-sm">{item.day} · {item.platform}/{item.account}</p><p className="text-sm whitespace-pre-wrap">{item.brief}</p></li>)}</ul></article>:null;})}</details>
          </div>}><main className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-4 sm:px-6" style={{borderColor:'#ededed'}}>
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
          <div className="flex gap-3 items-center"><Button variant="outline" onClick={()=>setPanelOpen(true)}>选题与版本</Button><Link className="text-sm underline" href={"/library?returnTo="+encodeURIComponent("/positioning/"+draftId+"/topics")}>打开内容资料库</Link></div>
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
                      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[#f5f5f6] px-4 py-3 text-[#303030]">
                        {e.input}
                      </p>
                      <User className="mt-3 h-5 w-5 shrink-0 text-[var(--text-secondary)]" />
                    </div>
                  )}
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--bg-primary)]">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 max-w-[85%] px-1 py-2">
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
                          const current=topicDraft.data?.requestId===e.executionId;
                          return <div className={topicStyles.group} aria-label={'本轮建议的 '+body.length+' 条选题'}>
                            {(current&&candidate?candidate.body:body).map((item,index)=>{
                              const adopted=adoptedItemIds.has(item.id);
                              return <section key={item.id} className={topicStyles.card}>
                                <p className={topicStyles.meta}>{item.platform} · {item.account} · {item.day}</p>
                                <h3>{index+1}. {item.title}</h3>
                                <p className={topicStyles.brief}>{item.brief}</p>
                                {current&&(adopted&&topicLink(item)?<Link className={topicStyles.action} href={topicLink(item)!}>继续这条内容工作</Link>:<button className={topicStyles.action} disabled={busy||Boolean(pending)||adopted} onClick={()=>void adoptCurrent([item.id])}>{adopted?'已采用':'采用这个选题'}</button>)}
                                {!current&&<p className={topicStyles.old}>过往建议 · 仅供查看</p>}
                              </section>;
                            })}
                            <p className={topicStyles.note}>候选留在对话中；只有明确采用的选题才进入资料库。右侧可查看选题草稿和版本。</p>
                          </div>;
                        })()}
                    </div>
                  </div>
                </article>
              ))}
              {candidate?.body.some(item => adoptedItemIds.has(item.id) && topicLink(item)) && (
                <section aria-label="已采用的选题" className="rounded-xl border bg-[var(--bg-primary)] p-4" style={{borderColor:'#e9e9e9'}}>
                  <h3 className="text-sm font-semibold">已采用的选题</h3>
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">继续会进入对应内容工作；未采用的选题仍留在本次讨论中。</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {candidate.body.filter(item => adoptedItemIds.has(item.id) && topicLink(item)).map(item => (
                      <button key={item.id} type="button" onClick={()=>location.assign(topicLink(item)!)} className="rounded-lg border border-[var(--border-primary)] px-3 py-2 text-sm hover:bg-[var(--bg-secondary)]">
                        继续 {item.title}
                      </button>
                    ))}
                  </div>
                </section>
              )}
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



          <footer className={composerStyles.zone}>
            <div className={composerStyles.wrap}>
              <div className={composerStyles.composer}>
                <Textarea
                  aria-label="消息"
                  placeholder="继续讨论、修改或要求生成第一周选题…"
                  value={input}
                  disabled={busy || Boolean(pending) || Boolean(view.data?.activeExecution)}
                  onChange={(event) => updateInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (!busy && !pending && input.trim() && !view.data?.activeExecution) void send();
                    }
                  }}
                  className={composerStyles.textarea}
                  rows={2}
                />
                <div className={composerStyles.tools}><span className="text-xs text-[var(--text-tertiary)]">本次讨论绑定已确认的定位与选题方法</span>
                <Button
                  aria-label="发送"
                  className={composerStyles.send}
                  disabled={busy || Boolean(pending) || !input.trim() || Boolean(view.data?.activeExecution)}
                  onClick={() => send()}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                </div>
              </div>
              <p className={composerStyles.note}>
                候选会自动保存；只有你明确采用的具体选题才会进入资料库。
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
    </main></WorkspaceFrame>
  );
}
