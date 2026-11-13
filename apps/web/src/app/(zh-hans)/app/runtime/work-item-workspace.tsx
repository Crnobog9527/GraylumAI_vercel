/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { TurnStepList } from '@/components/chat-display/turn-step-list';
import Link from 'next/link';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CHAT_ACTION, ChatInlineNotice, ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { AgentWorkStatus } from '@/components/chat-display/agent-work-status';
import {
  RuntimeEmptyState,
  RuntimeHeader,
  RuntimePendingMessage,
  RuntimeReply,
  RuntimeResultsSection,
  RuntimeTurnView,
  RuntimeTypePendingPanel
} from '@/components/chat-display/runtime-messages';
import { followTranscript, transcriptSignature } from '@/components/chat/chat-scroll';
import { ContentEditor } from '@/components/opc/content-editor';
import { WorkComposer } from '@/components/opc/work-composer';
import composerStyles from '@/components/opc/work-composer.module.css';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { QueryNotice } from '@/components/opc/query-notice';
import { RUNTIME_CHOICES_STALE_MS } from '@/lib/runtime-choices';
import { trpc } from '@/trpc/client';
import { clearForSend, forgetPending, markPendingRestored, openingDraftWithReferences, readPending, rememberPending, requestIdFor } from './send-input';
import { TURN_CONTINUE, TURN_PAUSED_NOTICE } from './turn-notices';
import { UNANSWERED_NOTE, unansweredByPlace } from './unanswered-turns';
import { workRowsOf } from './turn-work-rows';
import { useStoredSendCleanup } from './use-stored-send-cleanup';
import { useTurnChat } from './use-turn-chat';
import { displayReply, shownRuntimeInput } from './work-input';
import { currentFinalScript, guideRequest, SAVE_KINDS, savable, WORK_CONTINUE, type ContentVersion, type SaveKind, type SaveOperation } from './work-turn-path';
import { useWorkItemSteps } from './use-work-item-steps';
import { TYPE_LABEL, WorkSaveActions, WorkTypeChoice } from './work-item-parts';
import workStyles from './runtime-work.module.css';

/*
 * The topic window ("选题窗口"): a work item's conversation on the turn path (page.tsx; CORE-PATH-V2 V2-10b C2).
 * CONTENT-CONVERSATION-2 (Owner 2026-11-14): a conversation like free chat. The user says what to write ("写一版口播稿", "出分镜");
 * the model loads the writing Skill itself (load_skill); no fixed script button, Skill dropdown or storyboard/editing choice. A reply
 * is saved only when the user presses "存为…" under it; each save freezes its request in this browser first, so a repeat or a reload
 * resumes that request and never makes a second version. The opening guide stays: it says where the topic stands, it writes nothing.
 * A turn runs to its close: an ordinary work turn has no stop (Owner 10-28).
 */

export function WorkItemWorkspace({ sessionId, workItemId }: { sessionId: string; workItemId: string }) {
  const utils = trpc.useUtils();
  const choices = trpc.runtime.choices.useQuery({ sessionId }, { staleTime: RUNTIME_CHOICES_STALE_MS });
  const library = trpc.opc.library.useQuery({ search: '', from: null, to: null });
  const saved = trpc.opc.workResults.useQuery({ sessionId });
  const chat = useTurnChat(sessionId, () => {
    void utils.credits.getBalance.invalidate();
    void utils.opc.conversations.invalidate();
  });
  const [input, setInput] = useState(''),
    [outgoing, setOutgoing] = useState<string | null>(null),
    [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true),
    [saving, setSaving] = useState(false),
    [guiding, setGuiding] = useState(false);
  const [typePending, setTypePending] = useState(false),
    [heldGuide, setHeldGuide] = useState(false);
  const scrollArea = useRef<HTMLDivElement>(null),
    scrollState = useRef({ key: '', follow: true, signature: '' });
  const saveAttempt = useRef(false),
    guideAttempt = useRef(false);
  const saveKey = 'opc-final-turn:' + sessionId,
    inputKey = 'opc-runtime-input:' + sessionId;
  useEffect(() => {
    // A send not confirmed yet comes back into the box; its record keeps the request id, so sending it again replays.
    setInput(openingDraftWithReferences(localStorage, sessionId).text);
  }, [sessionId, inputKey]);
  const update = (value: string) => {
    setInput(value);
    localStorage.setItem(inputKey, value);
  };
  useStoredSendCleanup(sessionId, chat, input, next => {
    setInput(next);
    localStorage.setItem(inputKey, next);
  });

  const workItem = useMemo(() => {
    for (const business of library.data?.businesses ?? [])
      for (const account of business.accounts ?? [])
        for (const item of account.items ?? [])
          if (item.workItemId === workItemId)
            return { ...item, platform: account.platform, account: account.account, strategyDraftId: account.strategyDraftId ?? null };
    return null;
  }, [library.data, workItemId]);
  const versions = (workItem?.content ?? []) as ContentVersion[];
  const contentType: string = workItem?.contentType ?? 'unknown',
    isVideo = contentType === 'video';
  // The opening guide follows the item's bound method; a message the user sends names no Skill (the model loads one itself).
  const methodId = choices.data?.defaultSkill?.moduleId || '';
  const currentScript = currentFinalScript(versions);
  const busy = chat.busy || saving || guiding;
  const saveKinds = SAVE_KINDS[contentType] ?? [];
  // "新开一个选题": the topic discussion of this account's positioning, where new topics are proposed and adopted.
  const newTopicHref = workItem?.strategyDraftId ? `/app/positioning/${workItem.strategyDraftId}/topics` : null;

  const { save, setType, editPending } = useWorkItemSteps({ library, versions, workItem, saveKey, setError, setSaving, setTypePending });

  async function send(text: string, shown: string | null, requestKey = true) {
    const url = new URL(location.href);
    const requestId = requestIdFor(requestKey ? url.searchParams.get('request') : null, readPending(localStorage, sessionId), text, undefined, []);
    url.searchParams.set('request', requestId);
    history.replaceState(null, '', url);
    rememberPending(localStorage, sessionId, { requestId, text: shown ?? '', input: text, references: [] });
    const restore = clearForSend(setInput, shown ?? '', value => {
      localStorage.setItem(inputKey, value);
      markPendingRestored(localStorage, sessionId);
    });
    setOutgoing(shown);
    const answer = await chat.send(text, requestId, { workItem: true });
    setOutgoing(null);
    if (answer === 'kept') restore();
    if (answer !== 'unknown') {
      forgetPending(localStorage, sessionId);
      const done = new URL(location.href);
      done.searchParams.delete('request');
      history.replaceState(null, '', done);
    }
  }
  async function submit() {
    if (busy || !workItem || !choices.data || !input.trim()) return;
    setError('');
    await send(input, input);
  }
  async function guide() {
    if (!workItem || !methodId || contentType === 'unknown') return;
    const stage = versions.at(-1)?.id ?? workItem.workItemId;
    setGuiding(true);
    setError('');
    setHeldGuide(false);
    // The stage names the request: a repeat replays it and is never charged twice.
    const answer = await chat.send(guideRequest(stage, TYPE_LABEL[contentType]), stage, { moduleId: methodId, workItem: true });
    setGuiding(false);
    if (answer === 'unknown') setHeldGuide(true);
  }

  // After a reload: a save whose outcome was unknown resumes itself once, with its frozen request.
  useEffect(() => {
    if (saveAttempt.current || !workItem || !chat.view || saving) return;
    const raw = localStorage.getItem(saveKey);
    if (!raw) return;
    saveAttempt.current = true;
    const op: SaveOperation = JSON.parse(raw);
    void save({ turnId: op.turnId, requestId: op.requestId }, op.kind, op);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItem?.workItemId, chat.view, saving]);
  // ?continue is one start of the guide; consumed before sending, so a refused or reloaded guide never sends itself again.
  useEffect(() => {
    if (
      guideAttempt.current ||
      !workItem ||
      !chat.view ||
      !methodId ||
      contentType === 'unknown' ||
      chat.busy ||
      saving ||
      localStorage.getItem(saveKey) ||
      !new URL(location.href).searchParams.has('continue')
    )
      return;
    guideAttempt.current = true;
    const url = new URL(location.href);
    url.searchParams.delete('continue');
    history.replaceState(null, '', url);
    void guide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItem?.workItemId, chat.view, methodId, contentType, chat.busy, saving]);

  const messages = chat.view?.messages ?? [];
  const replies = messages.filter(m => m.role === 'assistant');
  const asked = (turnId: number | null) => messages.find(m => m.role === 'user' && m.turnId === turnId)?.content ?? null;
  // VOICE-ABORT-FIX: a question whose round was voided (no saved reply) still shows where it was asked, as in the free chat.
  const unanswered = unansweredByPlace(messages);
  const unansweredAt = (place: number) => (unanswered.get(place) ?? []).filter(m => !m.content.startsWith(WORK_CONTINUE)).map(m =>
    <RuntimeTurnView key={'unanswered-' + m.seq} userText={shownRuntimeInput(m.content)}>
      <ChatInlineNotice tone="status">{UNANSWERED_NOTE}</ChatInlineNotice>
    </RuntimeTurnView>);
  const signature = transcriptSignature(messages.map(m => m.seq).join('|'), outgoing ? { text: outgoing } : null);
  useEffect(() => {
    const node = scrollArea.current;
    if (!node || signature === undefined) return;
    scrollState.current = followTranscript(
      node,
      scrollState.current,
      'opc-runtime-scroll:' + sessionId,
      signature + (chat.live?.text.length ?? ''),
      () => null
    );
  }, [sessionId, signature, chat.live?.text.length]);
  const workRows = useMemo(() => workRowsOf(chat.view?.calls ?? []), [chat.view?.calls]);
  const paused = chat.paused && !chat.sending;
  const notices = [
    ...(paused
      ? [
          {
            id: 'turn-paused',
            tone: 'warning' as const,
            text: chat.notice?.text ?? TURN_PAUSED_NOTICE,
            actions: [{ label: TURN_CONTINUE, onClick: () => void chat.resume() }]
          }
        ]
      : chat.notice
        ? [{ id: 'turn-notice', tone: 'warning' as const, text: chat.notice.text }]
        : []),
    ...(error ? [{ id: 'work-error', tone: 'warning' as const, text: error }] : []),
    ...(heldGuide
      ? [
          {
            id: 'work-guide',
            tone: 'warning' as const,
            text: '引导请求状态待核实。',
            actions: [{ label: TURN_CONTINUE, onClick: () => void guide() }]
          }
        ]
      : [])
  ];
  const libraryHref = '/app/library?item=' + workItemId + '&return=' + sessionId;
  const showLive = outgoing !== null || chat.sending || Boolean(chat.view?.activeTurn && !paused);
  // A reply that starts with "{" is a proposal still being written as data: it is not shown, the steps keep saying what is happening.
  const liveText = chat.live?.text && !chat.live.text.trimStart().startsWith('{') ? chat.live.text : '';

  return (
    <WorkspaceFrame
      area="chat"
      activeWorkItemId={workItemId}
      turnBusy={chat.creditsBusy}
      rightOpen={panelOpen}
      onToggleRight={() => setPanelOpen(open => !open)}
      right={
        workItem ? (
          contentType === 'unknown' ? (
            <RuntimeTypePendingPanel />
          ) : (
            <ContentEditor key={workItem.workItemId + ':' + contentType} item={workItem} onSaved={() => library.refetch()}>
              <RuntimeResultsSection
                isVideo={isVideo}
                versions={versions}
                currentScriptId={currentScript?.id}
                saved={saved.data}
                libraryHref={libraryHref}
              />
            </ContentEditor>
          )
        ) : undefined
      }
    >
      <main className={`${workStyles.conversation} flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]`}>
        <RuntimeHeader
          title={workItem?.title ?? '工作对话'}
          meta={
            workItem
              ? {
                  platform: workItem.platform,
                  account: workItem.account,
                  infoHref: libraryHref,
                  showExpand: !panelOpen,
                  onExpand: () => setPanelOpen(true)
                }
              : undefined
          }
        />
        {newTopicHref && (
          <p className="px-6 pt-1 text-sm text-[var(--text-secondary)]">
            这个窗口只聊「{workItem?.title}」。要聊别的选题，
            <Link className="underline" href={newTopicHref}>
              新开一个选题
            </Link>
            。
          </p>
        )}
        <QueryNotice error={choices.error || library.error} label="当前工作" retry={() => Promise.all([choices.refetch(), library.refetch()])} />
        <div ref={scrollArea} className={workStyles.scrollArea} aria-label="对话记录">
          {!messages.length && !outgoing && <RuntimeEmptyState text="已带入选题简报和原工作方法，正在根据当前进度准备引导。" />}
          <section className={workStyles.transcript}>
            {workItem && typePending && (
              <ChatInlineNotice
                tone="warning"
                label="类型保存待核实"
                actions={[{ label: CHAT_ACTION.retry, disabled: editPending, onClick: () => void setType('unknown') }]}
              >
                内容类型保存结果待核实。
              </ChatInlineNotice>
            )}
            {workItem && contentType === 'unknown' && (
              <WorkTypeChoice disabled={busy || editPending || typePending} onChoose={value => void setType(value)} />
            )}
            {replies.map((reply, index) => {
              const question = asked(reply.turnId),
                canSave = savable(question) && reply.turnId !== null && Boolean(reply.content),
                text = displayReply(question, reply.content);
              const saved: Partial<Record<SaveKind, number>> = {};
              for (const v of versions) if (v.turnId === reply.turnId && reply.turnId !== null) saved[v.kind as SaveKind] = v.version;
              return (<Fragment key={reply.seq}>
                {unansweredAt(index)}
                <RuntimeTurnView
                  userText={question && !question.startsWith(WORK_CONTINUE) ? shownRuntimeInput(question) : null}
                  completed={canSave}
                >
                  {reply.turnId !== null && <TurnStepList steps={chat.stepsByTurn.get(reply.turnId) ?? reply.steps ?? []} />}
                  {reply.turnId !== null && <AgentWorkStatus items={workRows.get(reply.turnId) ?? []} />}
                  <RuntimeReply text={text} />
                  {canSave && saveKinds.length > 0 && (
                    <WorkSaveActions
                      kinds={saveKinds}
                      saved={saved}
                      href={libraryHref}
                      disabled={busy}
                      onSave={kind => void save({ turnId: reply.turnId!, requestId: reply.requestId ?? '' }, kind)}
                    />
                  )}
                </RuntimeTurnView>
              </Fragment>);
            })}
            {unansweredAt(replies.length)}
            {showLive && (
              <>
                {outgoing && <RuntimePendingMessage text={outgoing} sending={chat.sending} />}
                <RuntimeTurnView>
                  <TurnStepList steps={chat.live?.steps ?? []} live hasText={Boolean(liveText.trim())} />
                  <AgentWorkStatus items={chat.live?.rows ?? []} />
                  {chat.live?.trimmed.map(line => (
                    <ChatInlineNotice key={line} tone="status">
                      {line}
                    </ChatInlineNotice>
                  ))}
                  {liveText.trim() && <RuntimeReply text={liveText} streaming />}
                </RuntimeTurnView>
              </>
            )}
            <ChatNoticeList notices={notices} />
            {chat.viewFailed && <ChatInlineNotice tone="warning">暂时读取不到对话记录，页面会继续重试。</ChatInlineNotice>}
          </section>
        </div>
        <footer className={`${composerStyles.zone} ${workStyles.composerZone}`}>
          <div className={composerStyles.wrap}>
            <WorkComposer
              value={input}
              onChange={update}
              onSend={() => void submit()}
              sendDisabled={busy || !workItem || !choices.data}
              sessionId={sessionId}
              showSkills={false}
              note={
                isVideo
                  ? '直接说要什么，如"写一版口播稿""出分镜和剪辑建议"；满意哪版，点回复下的「存为…」。Enter 发送，Shift + Enter 换行。'
                  : '直接说要什么，如"写一版正文""改短一点"；满意哪版，点回复下的「存为正文」。Enter 发送，Shift + Enter 换行。'
              }
            />
          </div>
        </footer>
      </main>
    </WorkspaceFrame>
  );
}
