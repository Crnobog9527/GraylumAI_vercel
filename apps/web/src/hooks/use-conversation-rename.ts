'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getErrorMessageText } from '@/lib/safe-error-message';

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
  const [error, setError] = useState('');
  const saving = useRef(false);

  const start = useCallback((sessionId: string, title: string) => {
    setError('');
    setEditingId(sessionId);
    setValue(title);
  }, []);
  const cancel = useCallback(() => setEditingId(''), []);

  const save = useCallback(async (sessionId: string, previous: string) => {
    if (saving.current) return;
    const name = value.trim();
    setEditingId('');
    if (name === previous) return;
    saving.current = true;
    setError('');
    const setTitle = (title: string) => utils.opc.conversations.setData(undefined, (rows) =>
      rows?.map((row) => row.sessionId === sessionId ? { ...row, title } : row));
    if (name) setTitle(name);
    try {
      await utils.client.opc.conversationRename.mutate({ sessionId, name });
      // An empty name restores the server's default title; refresh either way in the background.
      void utils.opc.conversations.invalidate();
    } catch (cause) {
      setTitle(previous);
      setError(renameFailureMessage(cause));
      void utils.opc.conversations.invalidate();
    } finally {
      saving.current = false;
    }
  }, [utils, value]);

  return { editingId, value, setValue, error, start, cancel, save };
}
