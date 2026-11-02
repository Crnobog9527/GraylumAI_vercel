/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CHAT_ACTION, ChatInlineNotice, ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { AgentWorkStatus } from '@/components/chat-display/agent-work-status';
import {
  RuntimeEmptyState,
  RuntimeHeader,
  RuntimePendingMessage,
  RuntimeProposal,
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
import { workRowsOf } from './turn-work-rows';
import { useStoredSendCleanup } from './use-stored-send-cleanup';
import { useTurnChat } from './use-turn-chat';
import { displayReply, requestedVideoChoice, shownRuntimeInput, type VideoChoice } from './work-input';
import {
  adoptable,
  currentFinalScript,
  guideRequest,
  latestVersion,
  scriptSourceTurn,
  videoRequest,
  WORK_CONTINUE,
  type ContentVersion,
  type ScriptOperation,
  type VideoOperation
} from './work-turn-path';
import { useWorkItemSteps } from './use-work-item-steps';
import { TYPE_LABEL, WorkAdoptAction, WorkResultAction, WorkTypeChoice, WorkVideoChoices } from './work-item-parts';
import workStyles from './runtime-work.module.css';

/*
 * CORE-PATH-V2 V2-10b C2: a work item's conversation on the turn path (page.tsx).
 * The steps are the old page's: confirm the type, guide, adopt a reply, then storyboard and editing on an explicit choice. Each saved
 * step freezes its request in this browser first, so a repeat or a reload resumes that request and never makes a second one.
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
  const saveWorkResult = trpc.opc.saveWorkResult.useMutation();
  const [input, setInput] = useState(''),
    [outgoing, setOutgoing] = useState<string | null>(null),
    [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(true),
    [videoBusy, setVideoBusy] = useState(false),
    [guiding, setGuiding] = useState(false);
  const [skillId, setSkillId] = useState(''),
    [, repaint] = useState(0),
    [typePending, setTypePending] = useState(false),
    [heldGuide, setHeldGuide] = useState(false);
  const scrollArea = useRef<HTMLDivElement>(null),
    scrollState = useRef({ key: '', follow: true, signature: '' });
  const videoAttempt = useRef(false),
    scriptAttempt = useRef(new Set<string>()),
    guideAttempt = useRef(false);
  const videoKey = 'opc-video-turn:' + sessionId,
    scriptKey = 'opc-final-turn:' + sessionId,
    inputKey = 'opc-runtime-input:' + sessionId;
  useEffect(() => {
    // A send not confirmed yet comes back into the box; its record keeps the request id, so sending it again replays.
    setInput(openingDraftWithReferences(localStorage, sessionId).text);
    setSkillId(localStorage.getItem('opc-runtime-skill:' + sessionId) ?? '');
  }, [sessionId, inputKey]);
  const update = (value: string) => {
    setInput(value);
    localStorage.setItem(inputKey, value);
  };
  useStoredSendCleanup(sessionId, chat, input, next => {
    setInput(next);
    localStorage.setItem(inputKey, next);
  });
  const chooseSkill = (id: string) => {
    setSkillId(id);
    if (id) localStorage.setItem('opc-runtime-skill:' + sessionId, id);
    else localStorage.removeItem('opc-runtime-skill:' + sessionId);
  };

  const workItem = useMemo(() => {
    for (const business of library.data?.businesses ?? [])
      for (const account of business.accounts ?? [])
        for (const item of account.items ?? [])
          if (item.workItemId === workItemId) return { ...item, platform: account.platform, account: account.account };
    return null;
  }, [library.data, workItemId]);
  const versions = (workItem?.content ?? []) as ContentVersion[];
  const contentType: string = workItem?.contentType ?? 'unknown',
    isVideo = contentType === 'video';
  // The bound method by default: without a Skill the turn has no workSkill and its result cannot be saved.
  const moduleId = skillId || choices.data?.defaultSkill?.moduleId || '';
  const currentScript = currentFinalScript(versions);
  const sourceTurn = scriptSourceTurn(versions, currentScript);
  const hasFor = (kind: string) => Boolean(currentScript && versions.some(v => v.kind === kind && v.sourceContentId === currentScript.id));
  const currentStoryboard = hasFor('storyboard'),
    currentEditing = hasFor('editing');
  const videoEnded = Boolean(currentScript && typeof window !== 'undefined' && localStorage.getItem('opc-video-ended:' + currentScript.id));
  const busy = chat.busy || videoBusy || guiding;

  const { finalize, runVideo, setType, editPending } = useWorkItemSteps({
    chat,
    library,
    versions,
    workItem,
    isVideo,
    videoKey,
    scriptKey,
    setError,
    setVideoBusy,
    setTypePending
  });

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
    const answer = await chat.send(text, requestId, { ...(moduleId ? { moduleId } : {}), workItem: true });
    setOutgoing(null);
    if (answer === 'kept') restore();
    if (answer !== 'unknown') {
      forgetPending(localStorage, sessionId);
      const done = new URL(location.href);
      done.searchParams.delete('request');
      history.replaceState(null, '', done);
    }
  }
  async function submit(scriptRequest = false) {
    if (busy || !workItem || !choices.data) return;
    setError('');
    const choice = isVideo && currentScript ? requestedVideoChoice(input) : null;
    if (choice) {
      await chooseVideo(choice);
      return;
    }
    if (scriptRequest && !isVideo) return;
    if (!scriptRequest && !input.trim()) return;
    await send(
      scriptRequest ? '[OPC_SCRIPT_V1] 请基于当前选题简报讨论并给出可修改的口播稿。' + (input.trim() || '先给我一版口播稿。') : input,
      input.trim() ? input : null
    );
  }
  async function guide() {
    if (!workItem || !moduleId || contentType === 'unknown') return;
    const stage = versions.at(-1)?.id ?? workItem.workItemId;
    setGuiding(true);
    setError('');
    setHeldGuide(false);
    // The stage names the request: a repeat replays it and is never charged twice.
    const answer = await chat.send(guideRequest(stage, TYPE_LABEL[contentType]), stage, { moduleId, workItem: true });
    setGuiding(false);
    if (answer === 'unknown') setHeldGuide(true);
  }

  async function chooseVideo(choice: VideoChoice | 'end') {
    if (!isVideo || !currentScript || !workItem) return;
    if (choice === 'end') {
      localStorage.setItem('opc-video-ended:' + currentScript.id, 'true');
      repaint(n => n + 1);
      setError('');
      return;
    }
    if (choice === 'editing' && !currentStoryboard) {
      setError('请先完成这版口播稿的分镜，再基于分镜生成剪辑建议。');
      return;
    }
    if (!sourceTurn) {
      setError('这版口播稿缺少可恢复的来源，暂不能继续生成。');
      return;
    }
    if (
      (choice === 'both' && (currentStoryboard || currentEditing)) ||
      (choice === 'storyboard' && currentStoryboard) ||
      (choice === 'editing' && currentEditing)
    ) {
      setError('这版口播稿对应的所选成果已经生成，请在下方查看。');
      return;
    }
    const frozen = localStorage.getItem(videoKey);
    if (frozen) {
      await runVideo(JSON.parse(frozen));
      return;
    }
    if (!moduleId) {
      setError('请选择当前选题可用的 Skill，再继续生成。');
      return;
    }
    await runVideo({
      workItemId: workItem.workItemId,
      choice,
      moduleId,
      sourceScriptId: currentScript.id,
      script: { requestId: currentScript.requestId, turnId: sourceTurn, expectedVersion: currentScript.version - 1 },
      followup: { requestId: crypto.randomUUID(), input: videoRequest(choice) },
      package: { expectedStoryboardVersion: latestVersion(versions, 'storyboard'), expectedEditingVersion: latestVersion(versions, 'editing') }
    });
  }
  useEffect(() => {
    if (videoAttempt.current || !workItem || !chat.view || chat.busy || videoBusy) return;
    const raw = localStorage.getItem(videoKey),
      op: VideoOperation | null = raw ? JSON.parse(raw) : null;
    if (!op || op.held) return;
    videoAttempt.current = true;
    void runVideo(op);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItem?.workItemId, chat.view, chat.busy, videoBusy]);
  useEffect(() => {
    if (!workItem || !chat.view || videoBusy || scriptAttempt.current.has(scriptKey)) return;
    const raw = localStorage.getItem(scriptKey);
    if (!raw) return;
    scriptAttempt.current.add(scriptKey);
    const op: ScriptOperation = JSON.parse(raw);
    void finalize({ turnId: op.turnId, requestId: op.requestId }, op);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItem?.workItemId, chat.view, videoBusy]);
  // ?continue is one start of the guide; consumed before sending, so a refused or reloaded guide never sends itself again.
  useEffect(() => {
    if (
      guideAttempt.current ||
      !workItem ||
      !chat.view ||
      !moduleId ||
      contentType === 'unknown' ||
      chat.busy ||
      videoBusy ||
      localStorage.getItem(videoKey) ||
      localStorage.getItem(scriptKey) ||
      !new URL(location.href).searchParams.has('continue')
    )
      return;
    guideAttempt.current = true;
    const url = new URL(location.href);
    url.searchParams.delete('continue');
    history.replaceState(null, '', url);
    void guide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItem?.workItemId, chat.view, moduleId, contentType, chat.busy, videoBusy]);

  const messages = chat.view?.messages ?? [];
  const replies = messages.filter(m => m.role === 'assistant');
  const asked = (turnId: number | null) => messages.find(m => m.role === 'user' && m.turnId === turnId)?.content ?? null;
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
            {replies.map(reply => {
              const question = asked(reply.turnId),
                canAdopt = adoptable(reply.workSkill, question),
                text = displayReply(question, reply.content);
              const adopted = versions.some(v => v.kind === (isVideo ? 'script' : 'brief') && v.turnId === reply.turnId);
              const result = saved.data?.find((item: { turnId?: number | null }) => item.turnId === reply.turnId);
              return (
                <RuntimeTurnView
                  key={reply.seq}
                  userText={question && !question.startsWith(WORK_CONTINUE) ? shownRuntimeInput(question) : null}
                  completed={canAdopt}
                >
                  {reply.turnId !== null && <AgentWorkStatus items={workRows.get(reply.turnId) ?? []} />}
                  {canAdopt ? <RuntimeProposal adopted={adopted} text={text} /> : <RuntimeReply text={text} />}
                  {canAdopt && contentType !== 'unknown' && reply.turnId !== null && reply.requestId && (
                    <WorkAdoptAction
                      adopted={adopted}
                      isVideo={isVideo}
                      href={libraryHref}
                      disabled={busy}
                      onAdopt={() => void finalize({ turnId: reply.turnId!, requestId: reply.requestId! })}
                    />
                  )}
                  {canAdopt && contentType === 'unknown' && reply.turnId !== null && (
                    <WorkResultAction
                      version={result?.version ?? null}
                      disabled={saveWorkResult.isPending}
                      onSave={() => {
                        setError('');
                        void saveWorkResult.mutateAsync({ turnId: reply.turnId! }).then(
                          () => saved.refetch(),
                          () => {
                            void saved.refetch();
                            setError('Skill 成果保存结果待核实。可用同一条回复重试，不会创建重复成果。');
                          }
                        );
                      }}
                    />
                  )}
                </RuntimeTurnView>
              );
            })}
            {isVideo && currentScript && videoEnded && (!currentStoryboard || !currentEditing) && (
              <Button
                variant="outline"
                onClick={() => {
                  localStorage.removeItem('opc-video-ended:' + currentScript.id);
                  repaint(n => n + 1);
                }}
              >
                继续这版口播稿的分镜或剪辑
              </Button>
            )}
            {isVideo && currentScript && !videoEnded && (!currentStoryboard || !currentEditing) && (
              <WorkVideoChoices
                version={currentScript.version}
                storyboard={currentStoryboard}
                editing={currentEditing}
                busy={busy}
                onChoose={choice => void chooseVideo(choice)}
              />
            )}
            {showLive && (
              <>
                {outgoing && <RuntimePendingMessage text={outgoing} sending={chat.sending} />}
                <RuntimeTurnView>
                  <AgentWorkStatus items={chat.live?.rows ?? []} />
                  {chat.live?.trimmed.map(line => (
                    <ChatInlineNotice key={line} tone="status">
                      {line}
                    </ChatInlineNotice>
                  ))}
                  <RuntimeReply text={chat.live?.text && !chat.live.text.trimStart().startsWith('{') ? chat.live.text : '正在回复…'} streaming />
                </RuntimeTurnView>
              </>
            )}
            <ChatNoticeList notices={notices} />
            {chat.viewFailed && <ChatInlineNotice tone="warning">暂时读取不到对话记录，页面会继续重试。</ChatInlineNotice>}
          </section>
        </div>
        <footer className={`${composerStyles.zone} ${workStyles.composerZone}`}>
          <div className={composerStyles.wrap}>
            {isVideo && (
              <Button variant="outline" disabled={busy || !moduleId} onClick={() => void submit(true)}>
                {currentScript ? '修改口播稿' : '起草口播稿'}
              </Button>
            )}
            <WorkComposer
              value={input}
              onChange={update}
              onSend={() => void submit()}
              sendDisabled={busy || !workItem || !choices.data}
              sessionId={sessionId}
              skillId={moduleId}
              onSkillChange={chooseSkill}
              note="本次讨论参考当前工作的最新成果。Enter 发送，Shift + Enter 换行。"
            />
          </div>
        </footer>
      </main>
    </WorkspaceFrame>
  );
}
