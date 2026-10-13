/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import type { LiveReply } from '@/app/positioning/[draftId]/agent-turn-display';
import { isOpenTurn } from './runtime-notices';
import workStyles from './runtime-work.module.css';

/**
 * The streamed text to show for `executionId`, or null. It is display only: once the view
 * holds the turn finished, the saved reply and its notices take over. A video package streams
 * its JSON protocol, which is never shown as conversation; its saved result is.
 */
export function liveReplyText(reply: LiveReply | null, executionId: string,
  turn?: { state: string; input: string | null }): string | null {
  if (!reply || reply.executionId !== executionId || !reply.text) return null;
  if (turn && !isOpenTurn(turn.state)) return null;
  if (turn?.input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')) return null;
  return reply.text;
}

/** Changes whenever streamed text grows, so the transcript follows it like any other new content. */
export function liveScrollSignature(reply: LiveReply | null): string {
  return reply ? '|live:' + reply.executionId + ':' + reply.rev + ':' + reply.points : '';
}

/** The streamed text of one turn, as it arrives; nothing when there is none to show. */
export function LiveReplyText({ text }: { text: string | null }) {
  return text ? <MessageMarkdown className={workStyles.reply} text={text}/> : null;
}

/** A reply that streams before the view lists its turn (right after sending). */
export function PendingLiveReply({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className={workStyles.agentMessage} data-message-role="assistant">
    <div className={workStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/><span>Graylum · AI 自媒体陪跑教练</span></div>
    <LiveReplyText text={text}/>
  </div>;
}
