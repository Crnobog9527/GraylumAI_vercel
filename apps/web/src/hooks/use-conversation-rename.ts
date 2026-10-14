'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { getErrorMessageText } from '@/lib/safe-error-message';
import { createRenameRevisions } from '@/lib/conversation-rename';
import { forgetName, readNames, rememberName } from '@/lib/pending-conversation-rename';
import { outcomeUnknown } from '@/lib/request-outcome';

function tabStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

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
  // Names being saved, by conversation (only the latest edit of each); '' means "restore the default".
  // Seeded from this tab's storage, so a reload keeps showing them while they are sent again.
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(() => readNames(tabStorage()));
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
    if (name === null) next.delete(sessionId); else next.set(sessionId, name);
    return next;
  }), []);

  const send = useCallback((sessionId: string, name: string, attempt = 0) => {
    const revision = revisions.current.begin(sessionId);
    rememberName(tabStorage(), sessionId, name);
    setPendingName(sessionId, name);
    const run = async () => {
      let refused: unknown = null;
      try {
        await utils.client.opc.conversationRename.mutate({ sessionId, name });
      } catch (cause) {
        refused = cause;
      }
      const latest = revisions.current.isLatest(sessionId, revision);
      // No answer (reload, network) or an unexpected server failure: the name may be saved. Keep showing
      // it and keep the record; try again shortly, and the next page load sends it again too.
      if (refused !== null && outcomeUnknown(refused)) {
        if (latest && attempt < 2) setTimeout(() => { if (revisions.current.isLatest(sessionId, revision)) send(sessionId, name, attempt + 1); }, 2000);
        return;
      }
      // A saved non-empty name is the server's title now: put it in the list, so the screen stays right
      // even if the refresh below fails. (A cleared name's default title only comes with the refresh.)
      if (refused === null && name) {
        utils.opc.conversations.setData(undefined, (rows) =>
          rows?.map((row) => row.sessionId === sessionId ? { ...row, title: name } : row));
      }
      const refreshed = utils.opc.conversations.invalidate();
      if (refused === null) await Promise.resolve(refreshed).catch(() => undefined);
      // A saved name stays on screen until the refreshed list carries it (no flicker back to the old
      // title); a refused one gives way to the server's title at once. Only the latest edit of this
      // conversation ends its overlay and owns the message: an older one never touches a newer edit.
      if (latest && revisions.current.isLatest(sessionId, revision)) {
        forgetName(tabStorage(), sessionId);
        setPendingName(sessionId, null);
        setFailure((current) => refused ? { sessionId, text: renameFailureMessage(refused) }
          : current?.sessionId === sessionId ? null : current);
      }
    };
    const next = (queues.current.get(sessionId) ?? Promise.resolve()).then(run);
    queues.current.set(sessionId, next);
    void next.finally(() => { if (queues.current.get(sessionId) === next) queues.current.delete(sessionId); });
    return next;
  }, [utils, setPendingName]);

  const save = useCallback((sessionId: string, shown: string) => {
    const name = value.trim();
    setEditingId('');
    if (name === shown) return Promise.resolve();
    setFailure(null);
    return send(sessionId, name);
  }, [value, send]);

  // Names that were still being saved when this tab reloaded: send them again (same name, idempotent).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    for (const [sessionId, name] of readNames(tabStorage())) void send(sessionId, name);
  }, [send]);

  /** The title to show: a name being saved, otherwise the server's. */
  const titleOf = useCallback((sessionId: string, serverTitle: string) => pending.get(sessionId) || serverTitle, [pending]);

  return { editingId, value, setValue, error: failure?.text ?? '', start, cancel, save, titleOf };
}
