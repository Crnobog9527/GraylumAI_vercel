'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getErrorMessageText } from '@/lib/safe-error-message';
import { createRenameRevisions } from '@/lib/conversation-rename';

const REFUSALS: Array<[string, string]> = [
  ['OPC_CONVERSATION_ERASED', '这个对话已删除，不能重命名。'],
  ['OPC_CONVERSATION_NOT_FOUND', '找不到这个对话，名字没有保存。'],
  ['OPC_CONVERSATION_NAME_INVALID', '名字最多 80 个字，不能包含换行。'],
];

export function renameFailureMessage(error: unknown) {
  const text = getErrorMessageText(error);
  return REFUSALS.find(([code]) => text.includes(code))?.[1] ?? '名字没有保存，请稍后再试。';
}

/**
 * Inline rename of an ordinary conversation (UI-FINISH, Owner 2026-10-13). A name being saved is shown
 * as an overlay on top of the server list and never written into the shared query cache, so a list
 * refetch (for this or any other conversation) cannot replace it, and dropping the overlay always
 * falls back to the server's own title. An empty name restores the server's default title.
 */
export function useConversationRename() {
  const utils = trpc.useUtils();
  const [editingId, setEditingId] = useState('');
  const [value, setValue] = useState('');
  // The message belongs to one conversation's latest edit; a later success there clears it.
  const [failure, setFailure] = useState<{ sessionId: string; text: string } | null>(null);
  // Names being saved, by conversation (only the latest edit of each).
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Saves of one conversation run in order; different conversations save independently.
  const queues = useRef(new Map<string, Promise<void>>());
  const revisions = useRef(createRenameRevisions());

  const start = useCallback((sessionId: string, title: string) => {
    setFailure(null);
    setEditingId(sessionId);
    setValue(title);
  }, []);
  const cancel = useCallback(() => setEditingId(''), []);

  const setPendingName = useCallback((sessionId: string, name: string | null) => setPending((current) => {
    const next = new Map(current);
    if (name) next.set(sessionId, name); else next.delete(sessionId);
    return next;
  }), []);

  const save = useCallback((sessionId: string, shown: string) => {
    const name = value.trim();
    setEditingId('');
    if (name === shown) return Promise.resolve();
    setFailure(null);
    const revision = revisions.current.begin(sessionId);
    // Clearing the name shows the server's title until the refresh brings the default back.
    setPendingName(sessionId, name || null);
    const run = async () => {
      let refused: unknown = null;
      try {
        await utils.client.opc.conversationRename.mutate({ sessionId, name });
      } catch (cause) {
        refused = cause;
      }
      // A saved name stays on screen until the refreshed list carries it (no flicker back to the old
      // title); a refused one gives way to the server's title at once. Only the latest edit of this
      // conversation ends its overlay and owns the message: an older one never touches a newer edit.
      // A saved non-empty name is the server's title now: put it in the list, so the screen stays right
      // even if the refresh below fails. (A cleared name's default title only comes with the refresh.)
      if (refused === null && name) {
        utils.opc.conversations.setData(undefined, (rows) =>
          rows?.map((row) => row.sessionId === sessionId ? { ...row, title: name } : row));
      }
      const refreshed = utils.opc.conversations.invalidate();
      if (refused === null) await Promise.resolve(refreshed).catch(() => undefined);
      if (revisions.current.isLatest(sessionId, revision)) {
        setPendingName(sessionId, null);
        setFailure((current) => refused ? { sessionId, text: renameFailureMessage(refused) }
          : current?.sessionId === sessionId ? null : current);
      }
    };
    const next = (queues.current.get(sessionId) ?? Promise.resolve()).then(run);
    queues.current.set(sessionId, next);
    void next.finally(() => { if (queues.current.get(sessionId) === next) queues.current.delete(sessionId); });
    return next;
  }, [utils, value, setPendingName]);

  /** The title to show: a name being saved, otherwise the server's. */
  const titleOf = useCallback((sessionId: string, serverTitle: string) => pending.get(sessionId) ?? serverTitle, [pending]);

  return { editingId, value, setValue, error: failure?.text ?? '', start, cancel, save, titleOf };
}
