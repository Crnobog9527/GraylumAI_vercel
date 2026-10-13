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
 * Inline rename of an ordinary conversation (UI-FINISH, Owner 2026-10-13). The new name shows at once;
 * a refusal puts the old title back and says why. An empty name restores the default title.
 */
export function useConversationRename() {
  const utils = trpc.useUtils();
  const [editingId, setEditingId] = useState('');
  const [value, setValue] = useState('');
  // The message belongs to one conversation's latest edit; a later success there clears it.
  const [failure, setFailure] = useState<{ sessionId: string; text: string } | null>(null);
  // Saves of one conversation run in order; different conversations save independently.
  const queues = useRef(new Map<string, Promise<void>>());
  // Latest edit per conversation: only that edit may roll the shown title back.
  const revisions = useRef(createRenameRevisions());

  const start = useCallback((sessionId: string, title: string) => {
    setFailure(null);
    setEditingId(sessionId);
    setValue(title);
  }, []);
  const cancel = useCallback(() => setEditingId(''), []);

  const save = useCallback((sessionId: string, previous: string) => {
    const name = value.trim();
    setEditingId('');
    if (name === previous) return Promise.resolve();
    setFailure(null);
    const setTitle = (title: string) => utils.opc.conversations.setData(undefined, (rows) =>
      rows?.map((row) => row.sessionId === sessionId ? { ...row, title } : row));
    if (name) setTitle(name);
    const revision = revisions.current.begin(sessionId, previous);
    const run = async () => {
      try {
        const saved = await utils.client.opc.conversationRename.mutate({ sessionId, name });
        revisions.current.settle(sessionId, saved.name ?? '');
        // Only the latest edit clears the error and refreshes the list: a refetch while a newer edit of
        // this conversation is queued could show this older title over it. An empty name restores the
        // server's default title, which the refresh brings.
        if (revisions.current.isLatest(sessionId, revision)) {
          setFailure((current) => current?.sessionId === sessionId ? null : current);
          void utils.opc.conversations.invalidate();
        }
      } catch (cause) {
        revisions.current.settle(sessionId, null);
        // A failure superseded by a newer edit of the same conversation changes nothing: that edit
        // decides. Otherwise show the last title the server confirmed, not an unsaved optimistic one.
        if (revisions.current.isLatest(sessionId, revision)) {
          setTitle(revisions.current.rollbackTitle(sessionId, previous));
          setFailure({ sessionId, text: renameFailureMessage(cause) });
          void utils.opc.conversations.invalidate();
        }
      }
    };
    const next = (queues.current.get(sessionId) ?? Promise.resolve()).then(run);
    queues.current.set(sessionId, next);
    void next.finally(() => { if (queues.current.get(sessionId) === next) queues.current.delete(sessionId); });
    return next;
  }, [utils, value]);

  return { editingId, value, setValue, error: failure?.text ?? '', start, cancel, save };
}
