/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import { latestVersion, SAVE_REJECTIONS, saveRefusal, saveStatus, type ContentVersion, type SaveKind, type SaveOperation } from './work-turn-path';

const message = (cause: unknown) => (cause instanceof Error ? cause.message : '');
type WorkItem = { workItemId: string; revision: number; title: string; brief?: string | null; day: string };

/** A work item's saves and its type (V2-10b C2, CONTENT-CONVERSATION-2): each save frozen in this browser first, so a repeat resumes
 *  that request and never makes a second version. */
export function useWorkItemSteps({ library, versions, workItem, saveKey, setError, setSaving, setTypePending }: {
  library: { refetch: () => Promise<unknown> }; versions: readonly ContentVersion[]; workItem: WorkItem | null;
  saveKey: string; setError: (text: string) => void; setSaving: (busy: boolean) => void; setTypePending: (pending: boolean) => void;
}): { save: (reply: { turnId: number; requestId: string }, kind: SaveKind, frozen?: SaveOperation) => Promise<void>;
  setType: (value: string) => Promise<void>; editPending: boolean } {
  const editItem = trpc.opc.editLibrary.useMutation(), saveContent = trpc.opc.saveContentFromTurn.useMutation();

  async function save(reply: { turnId: number; requestId: string }, kind: SaveKind, frozen?: SaveOperation) {
    if (!workItem) return;
    // A request whose outcome is unknown stays the request: its version condition, until the result is definite. A new reply or
    // another kind is a new request (its own id), so the same reply can be saved once as each kind.
    const held: SaveOperation | null = frozen ?? (() => { const raw = localStorage.getItem(saveKey); return raw ? JSON.parse(raw) : null; })();
    const op: SaveOperation = held && held.turnId === reply.turnId && held.kind === kind ? held : {
      kind,
      workItemId: workItem.workItemId,
      requestId: crypto.randomUUID(),
      turnId: reply.turnId,
      expectedVersion: latestVersion(versions, kind)
    };
    setSaving(true);
    setError('');
    try {
      localStorage.setItem(saveKey, JSON.stringify(op));
      await saveContent.mutateAsync({
        workItemId: op.workItemId,
        requestId: op.requestId,
        expectedVersion: op.expectedVersion,
        kind: op.kind,
        status: saveStatus(op.kind),
        turnId: op.turnId,
        sourceContentId: null
      });
      localStorage.removeItem(saveKey);
      await library.refetch();
    } catch (cause) {
      if (SAVE_REJECTIONS.has(message(cause))) {
        localStorage.removeItem(saveKey);
        setError(saveRefusal(message(cause), op.kind));
        await library.refetch();
      } else setError('保存结果待核实。再点一次只会继续这一次保存，不会存出两份。');
    } finally {
      setSaving(false);
    }
  }
  async function setType(value: string) {
    if (!workItem) return;
    const key = 'opc-content-type:' + workItem.workItemId;
    try {
      const raw = localStorage.getItem(key);
      const frozen = raw
        ? JSON.parse(raw)
        : {
            requestId: crypto.randomUUID(),
            target: 'item' as const,
            targetId: workItem.workItemId,
            expectedRevision: workItem.revision,
            patch: { title: workItem.title, brief: workItem.brief ?? '', day: workItem.day, contentType: value }
          };
      localStorage.setItem(key, JSON.stringify(frozen));
      setTypePending(true);
      await editItem.mutateAsync(frozen);
      localStorage.removeItem(key);
      setTypePending(false);
      await library.refetch();
    } catch (cause) {
      if (['OPC_VERSION_CONFLICT', 'OPC_REQUEST_CONFLICT', 'OPC_DENIED', 'OPC_LIBRARY_INVALID'].includes(message(cause))) {
        localStorage.removeItem(key);
        setTypePending(false);
        await library.refetch();
        setError('类型保存已明确拒绝，已读取当前版本，请重新确认。');
      } else setError('类型保存状态待核实；再次选择会恢复原请求，不会覆盖其他修改。');
    }
  }
  return { save, setType, editPending: editItem.isPending };
}
