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

type PlanItem = {
  id: string;
  platform: string;
  account: string;
  title: string;
  brief: string;
  day: string;
};

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
  const [pending, setPending] = useState<{ requestId: string; input: string } | null>(null);
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
  const bind = trpc.opc.bindTopicWorkspace.useMutation();
  const turn = trpc.opc.topicTurn.useMutation();
  const execute = trpc.runtime.execute.useMutation();
  const cancel = trpc.runtime.cancel.useMutation();
  const savePlan = trpc.opc.savePlan.useMutation();
  const handoff = trpc.opc.handoff.useMutation();

  const busy = turn.isPending || execute.isPending || bind.isPending;
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
    setNotice('');
    const sourceVersionId = read.data?.report?.id;
    if (!sourceVersionId) {
      setError('请先确认正式定位，再开始选题工作对话。');
      return;
    }
    try {
      await bind.mutateAsync({ draftId, requestId: crypto.randomUUID(), sourceVersionId });
      await workspace.refetch();
    } catch (cause) {
      setError(failureMessage(cause));
    }
  }

  async function send(requestId = crypto.randomUUID(), text = input) {
    if (!sessionId || !text.trim()) return;
    setError('');
    setNotice('');
    setPending({ requestId, input: text });
    try {
      const admitted = await turn.mutateAsync({ draftId, requestId, input: text });
      await execute.mutateAsync({ executionId: admitted.executionId });
      setPending(null);
      setInput('');
      await view.refetch();
    } catch (cause) {
      setError(failureMessage(cause));
      await view.refetch();
    }
  }

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
    if (!candidate) return;
    setError('');
    setNotice('');
    try {
      const saved = await savePlan.mutateAsync({
        draftId,
        requestId: candidate.requestId,
        expectedVersion: nextVersion,
        sourceVersionId: workspace.data?.sourceVersionId ?? '',
        body: candidate.body,
      });
      setNotice('已保存为第 ' + saved.version + ' 版候选；采纳仍然需要你这一次的明确确认。');
      setCandidate(null);
      await read.refetch();
    } catch (cause) {
      setError(failureMessage(cause));
    }
  }

  async function adopt(planId: string, body: PlanItem[]) {
    setError('');
    setNotice('');
    const chosen = body.filter((item) =>
      selectedAccounts.includes(item.platform + '::' + item.account),
    );
    const unique = new Map(chosen.map((item) => [item.platform + '::' + item.account, item]));
    if (!unique.size) {
      setError('请先选择要承接的平台账号。');
      return;
    }
    try {
      // One explicit adoption keeps one identity: the same plan version and the
      // same selected accounts replay the original handoff request instead of
      // creating a new one on every click.
      const adoptKey =
        'opc-topic-adopt:' + draftId + ':' + planId;
      const selectionKey = [...unique.keys()].sort().join(',');
      const retainedAdopt = sessionStorage.getItem(adoptKey);
      let adoptRequestId = crypto.randomUUID();
      if (retainedAdopt) {
        try {
          const parsed = JSON.parse(retainedAdopt) as {
            requestId?: string;
            selectionKey?: string;
          };
          if (parsed.selectionKey === selectionKey && parsed.requestId)
            adoptRequestId = parsed.requestId;
        } catch {
          /* An unreadable local record never authorizes the new identity. */
        }
      }
      sessionStorage.setItem(
        adoptKey,
        JSON.stringify({ requestId: adoptRequestId, selectionKey }),
      );
      const result = await handoff.mutateAsync({
        draftId,
        requestId: adoptRequestId,
        planId,
        accounts: [...unique.values()].map((item) => ({
          platform: item.platform,
          account: item.account,
          expectedRevision:
            accounts.find((a) => a.platform === item.platform && a.account === item.account)
              ?.revision ?? null,
        })),
      });
      sessionStorage.removeItem(adoptKey);
      setAdopted(result as typeof adopted);
      setNotice('已按你选择的账号承接这一次的计划；每个选题都有独立工作空间。');
      await read.refetch();
    } catch (cause) {
      setError(failureMessage(cause));
    }
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
    <main className="flex h-dvh min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
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
                  (workspace.data?.revisionId ?? '').slice(0, 8)
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
            你可以反复对话、修改候选，之后再明确采纳。绑定本身不调用模型，也不产生费用。
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
          <div className="min-h-0 flex-1 overflow-y-auto" aria-label="选题对话记录">
            {!executions?.length && (
              <div className="mx-auto flex min-h-48 max-w-xl flex-col items-center justify-center px-6 py-10 text-center">
                <Bot className="mb-3 h-8 w-8 text-[var(--color-primary)]" />
                <p className="text-sm text-[var(--text-tertiary)]">
                  说一句你想先解决的问题，例如「先给我一版第一周选题，我再改」。
                </p>
              </div>
            )}
            <section className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
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
                            <Button
                              className="mt-3"
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                setNotice('');
                                setCandidate({ body, requestId: crypto.randomUUID() });
                              }}
                            >
                              把这条回复保存为候选版本
                            </Button>
                          );
                        })()}
                    </div>
                  </div>
                </article>
              ))}
              {pending && (
                <div className="rounded-xl border border-[var(--border-primary)] p-4">
                  <p role="status" className="text-sm">
                    上一条消息的结果尚未确认（原请求已冻结）。可用同一个身份重试，不会重复计费。
                  </p>
                  <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => send(pending.requestId, pending.input)}>
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
                      {item.day} · {item.platform}/{item.account} · {item.title}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" disabled={savePlan.isPending} onClick={saveCandidate}>
                    保存这一版候选
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCandidate(null)}>
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
                                  {item.day} · {item.platform}/{item.account} · {item.title}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                        <Button
                          className="mt-3"
                          size="sm"
                          disabled={handoff.isPending}
                          onClick={() => adopt(plan.planId, plan.body as PlanItem[])}
                        >
                          按所选账号采纳这次计划
                        </Button>
                      </>
                    ) : (
                      <p role="status" className="mt-2 text-sm">
                        来源已不可用，暂不能采纳此版本。
                      </p>
                    )}
                  </article>
                ))}
                {adopted.map((item) => (
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
                  disabled={busy || Boolean(view.data?.activeExecution)}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (!busy && input.trim() && !view.data?.activeExecution) void send();
                    }
                  }}
                  className="min-h-12 max-h-36 flex-1 resize-none border-0 bg-transparent px-2 focus-visible:ring-0"
                  rows={2}
                />
                <Button
                  aria-label="发送"
                  className="h-10 w-10 shrink-0 rounded-xl p-0"
                  disabled={busy || !input.trim() || Boolean(view.data?.activeExecution)}
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
