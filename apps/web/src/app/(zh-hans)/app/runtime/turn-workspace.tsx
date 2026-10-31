/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatInlineNotice, ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { AgentWorkStatus } from '@/components/chat-display/agent-work-status';
import {
  RuntimeEmptyState, RuntimeHeader, RuntimePendingMessage, RuntimeReply, RuntimeTurnView,
} from '@/components/chat-display/runtime-messages';
import { followTranscript, transcriptSignature } from '@/components/chat/chat-scroll';
import { WorkComposer } from '@/components/opc/work-composer';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { SaveReplyButton, SessionResultsPanel } from '@/components/opc/session-results';
import composerStyles from '@/components/opc/work-composer.module.css';
import { trpc } from '@/trpc/client';
import { RUNTIME_CHOICES_STALE_MS } from '@/lib/runtime-choices';
import { CompareButton } from '@/components/fusion-compare/ComparePicker';
import { CompareThread, useCompareThread } from '@/components/fusion-compare/CompareThread';
import {
  clearForSend, forgetPending, markPendingRestored, openingDraftWithReferences, readPending, rememberPending, requestIdFor, saveDraftReferences,
} from './send-input';
import {
  COMPOSER_REFERENCES_ENABLED, referenceRequest, referencesNamedIn, type LibraryReference,
} from '@/components/opc/composer-references';
import { positioningRequiredNotice } from './positioning-required';
import { POSITIONING_REQUIRED_NOTICE } from './gate-notices';
import { TURN_CONTINUE, TURN_PAUSED_NOTICE } from './turn-notices';
import { workRowsOf } from './turn-work-rows';
import { useTurnChat } from './use-turn-chat';
import workStyles from './runtime-work.module.css';

/*
 * CORE-PATH-V2 V2-10: the free conversation on the turn path (core_path_v2.enabled). Each user message and the reply saved with it
 * (session_messages) is one turn of the transcript, after whatever the old path already holds. An ordinary conversation has no
 * stop: a turn runs to its close (Owner 10-28).
 */
type OldTurn = { executionId: string; input: string | null; body: string | null; primaryBody: string | null };
export function TurnWorkspace({ sessionId, oldTurns }: { sessionId: string; oldTurns: readonly OldTurn[] }) {
  const utils = trpc.useUtils();
  const results = trpc.opc.sessionResults.useQuery({ sessionId }, { retry: false });
  // The conversation's compares stay as they are: their cards run, stop and adopt on the compare router, whichever path the
  // conversation's turns take. Cards follow the history (a saved message has no clock to place one by).
  const compare = useCompareThread(sessionId);
  const choices = trpc.runtime.choices.useQuery({ sessionId }, { staleTime: RUNTIME_CHOICES_STALE_MS });
  const chat = useTurnChat(sessionId, () => { void utils.credits.getBalance.invalidate(); void utils.opc.conversations.invalidate(); });
  const [input, setInput] = useState(''), [outgoing, setOutgoing] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true), [reveal, setReveal] = useState(0);
  const scrollArea = useRef<HTMLDivElement>(null), scrollState = useRef({ key: '', follow: true, signature: '' });
  const [skillId, setSkillId] = useState(''), [references, setReferences] = useState<LibraryReference[]>([]);
  useEffect(() => {
    const draft = openingDraftWithReferences(localStorage, sessionId);
    setInput(draft.text); setSkillId(localStorage.getItem('opc-runtime-skill:' + sessionId) ?? '');
    setReferences(COMPOSER_REFERENCES_ENABLED ? referencesNamedIn(draft.text, draft.references) : []);
  }, [sessionId]);
  const updateReferences = (next: LibraryReference[]) => { setReferences(next); saveDraftReferences(localStorage, sessionId, next); };
  const chooseSkill = (id: string) => {
    setSkillId(id);
    if (id) localStorage.setItem('opc-runtime-skill:' + sessionId, id); else localStorage.removeItem('opc-runtime-skill:' + sessionId);
  };
  const update = (value: string) => { setInput(value); localStorage.setItem('opc-runtime-input:' + sessionId, value); };

  async function send(text = input) {
    if (!text.trim() || chat.busy) return;
    // An unconfirmed earlier send of the same text keeps its request id, so the server replays instead of charging twice.
    const url = new URL(location.href);
    const sent = COMPOSER_REFERENCES_ENABLED ? referencesNamedIn(text, references) : [];
    const requestId = requestIdFor(url.searchParams.get('request'), readPending(localStorage, sessionId), text, undefined, sent);
    url.searchParams.set('request', requestId); history.replaceState(null, '', url);
    rememberPending(localStorage, sessionId, { requestId, text, input: text, references: sent });
    setReferences([]);
    const restore = clearForSend(setInput, text, saved => {
      localStorage.setItem('opc-runtime-input:' + sessionId, saved); markPendingRestored(localStorage, sessionId);
    });
    setOutgoing(text);
    const answer = await chat.send(text, requestId, { ...(skillId ? { moduleId: skillId } : {}),
      ...(sent.length ? { references: referenceRequest(sent) } : {}) });
    setOutgoing(null);
    if (answer === 'kept') { restore(); updateReferences(sent); }
    if (answer !== 'unknown') {
      forgetPending(localStorage, sessionId);
      const done = new URL(location.href); done.searchParams.delete('request'); history.replaceState(null, '', done);
    }
  }
  // The marker records one explicit send on the start page, never mere navigation; consumed on this attempt.
  const initial = useRef(false);
  useEffect(() => {
    if (initial.current || !input.trim() || !chat.view || chat.busy) return;
    const marker = sessionStorage.getItem('opc-runtime-send:' + sessionId);
    if (!marker || new URL(location.href).searchParams.get('request') !== marker) return;
    initial.current = true; sessionStorage.removeItem('opc-runtime-send:' + sessionId); void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, input, chat.view, chat.busy]);

  const chosenSkill = choices.data?.skills.find(skill => skill.moduleId === skillId);
  const compareSkill = { ready: Boolean(choices.data && (!skillId || chosenSkill)),
    skill: chosenSkill ? { kind: 'skill' as const, moduleId: chosenSkill.moduleId, revisionId: chosenSkill.revisionId } : undefined };
  const messages = chat.view?.messages ?? [];
  const turns = messages.filter(m => m.role === 'assistant');
  const asked = (turnId: number | null) => messages.find(m => m.role === 'user' && m.turnId === turnId)?.content ?? null;
  const signature = transcriptSignature(messages.map(m => m.seq).join('|'), outgoing ? { text: outgoing } : null);
  useEffect(() => {
    const node = scrollArea.current;
    if (!node || signature === undefined) return;
    scrollState.current = followTranscript(node, scrollState.current, 'opc-runtime-scroll:' + sessionId,
      signature + (chat.live?.text.length ?? ''), () => null);
  }, [sessionId, signature, chat.live?.text.length]);

  const workRows = useMemo(() => workRowsOf(chat.view?.calls ?? []), [chat.view?.calls]);
  const paused = chat.paused && !chat.sending;
  const notices = chat.notice?.text === POSITIONING_REQUIRED_NOTICE ? [positioningRequiredNotice('turn-positioning')]
    : chat.notice && !paused ? [{ id: 'turn-notice', tone: 'warning' as const, text: chat.notice.text }]
    : paused ? [{ id: 'turn-paused', tone: 'warning' as const, text: chat.notice?.text ?? TURN_PAUSED_NOTICE,
      actions: [{ label: TURN_CONTINUE, onClick: () => void chat.resume() }] }] : [];
  const pendingText = outgoing ?? (chat.view?.activeTurn && !paused ? '' : null);
  return <WorkspaceFrame area="chat" revealRight={reveal} rightOpen={panelOpen} onToggleRight={() => setPanelOpen(open => !open)}
    right={results.data?.length ? <SessionResultsPanel sessionId={sessionId} items={results.data}/> : undefined}>
    <main className={`${workStyles.conversation} flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]`}>
      <RuntimeHeader title="工作对话"/>
      <div ref={scrollArea} className={workStyles.scrollArea} aria-label="对话记录">
        {!oldTurns.length && !messages.length && !outgoing && <RuntimeEmptyState text="输入一条消息，发送后可刷新查看记录。"/>}
        <section className={workStyles.transcript}>
          {oldTurns.map(turn => <RuntimeTurnView key={turn.executionId} userText={turn.input}>
            <RuntimeReply text={turn.body ?? turn.primaryBody ?? ''} available={Boolean(turn.body ?? turn.primaryBody)}/>
          </RuntimeTurnView>)}
          {turns.map(reply => <RuntimeTurnView key={reply.seq} userText={asked(reply.turnId)}>
            {reply.turnId !== null && <AgentWorkStatus items={workRows.get(reply.turnId) ?? []}/>}
            <RuntimeReply text={reply.content}/>
            {results.data && reply.turnId !== null && <SaveReplyButton sessionId={sessionId} turnId={reply.turnId} reply={reply.content}
              savedItems={results.data.filter(item => item.sourceTurnId === reply.turnId)}
              onOpenResults={() => { setPanelOpen(true); setReveal(count => count + 1); }}/>}
          </RuntimeTurnView>)}
          <CompareThread cards={compare.cards} names={compare.names} onQuote={update}
            onAdopted={() => { void compare.refresh(); void chat.reload(); }}/>
          {pendingText !== null && <>
            {pendingText && <RuntimePendingMessage text={pendingText} sending={chat.sending}/>}
            <RuntimeTurnView>
              <AgentWorkStatus items={chat.live?.rows ?? []}/>
              {chat.live?.trimmed.map(line => <ChatInlineNotice key={line} tone="status">{line}</ChatInlineNotice>)}
              <RuntimeReply text={chat.live?.text || '正在回复…'} streaming/>
            </RuntimeTurnView>
          </>}
          <ChatNoticeList notices={notices}/>
          {chat.viewFailed && <ChatInlineNotice tone="warning">暂时读取不到对话记录，页面会继续重试。</ChatInlineNotice>}
        </section>
      </div>
      <footer className={`${composerStyles.zone} ${workStyles.composerZone}`}><div className={composerStyles.wrap}>
        <CompareButton sessionId={sessionId} question={input} disabled={chat.busy || !compareSkill.ready} skill={compareSkill.skill}
          blockedReason={messages.length ? '这个对话已经用上新的对话通道，多模型对比暂时读不到它的上文，接入完成前先不能发起。已有的对比结果照常查看。'
            : COMPOSER_REFERENCES_ENABLED && referencesNamedIn(input, references).length
              ? '带 @ 引用资料的消息暂时不能多模型对比，请去掉引用后再试。' : undefined}
          onStarted={compareId => { update(''); compare.add(compareId); void compare.refresh(); }} onMaybeStarted={() => void compare.refresh()}/>
        <WorkComposer value={input} onChange={update} onSend={() => void send()} sendDisabled={chat.busy} sessionId={sessionId}
          skillId={skillId} onSkillChange={chooseSkill} referenceList={references} onReferencesChange={updateReferences}/>
      </div></footer>
    </main>
  </WorkspaceFrame>;
}
