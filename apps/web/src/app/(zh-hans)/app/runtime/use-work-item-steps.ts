/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { trpc } from '@/trpc/client';
import type { useTurnChat } from './use-turn-chat';
import {
  latestVersion, replyOfRequest, SCRIPT_REJECTIONS, VIDEO_REJECTIONS, type ContentVersion, type ScriptOperation, type VideoOperation,
} from './work-turn-path';

const message = (cause: unknown) => (cause instanceof Error ? cause.message : '');
type WorkItem = { workItemId: string; revision: number; title: string; brief?: string | null; day: string };

/** A work item's saved steps (V2-10b C2): each frozen in this browser first, so a repeat resumes that request. */
export function useWorkItemSteps({ chat, library, versions, workItem, isVideo, videoKey, scriptKey, setError, setVideoBusy, setTypePending }: {
  chat: ReturnType<typeof useTurnChat>; library: { refetch: () => Promise<unknown> }; versions: readonly ContentVersion[]; workItem: WorkItem | null;
  isVideo: boolean; videoKey: string; scriptKey: string; setError: (text: string) => void; setVideoBusy: (busy: boolean) => void;
  setTypePending: (pending: boolean) => void;
}) {
  const editItem = trpc.opc.editLibrary.useMutation(), saveContent = trpc.opc.saveContentFromTurn.useMutation();
  const prepareVideo = trpc.opc.prepareVideoMaterial.useMutation(), saveVideo = trpc.opc.saveVideoResultsFromTurn.useMutation();

  async function finalize(reply: { turnId: number; requestId: string }, frozen?: ScriptOperation) {
    if (!workItem) return;
    const kind = isVideo ? 'script' : 'brief';
    const op: ScriptOperation = frozen ?? {
      kind,
      workItemId: workItem.workItemId,
      requestId: reply.requestId,
      turnId: reply.turnId,
      expectedVersion: latestVersion(versions, kind)
    };
    setVideoBusy(true);
    setError('');
    try {
      localStorage.setItem(scriptKey, JSON.stringify(op));
      await saveContent.mutateAsync({
        workItemId: op.workItemId,
        requestId: op.requestId,
        expectedVersion: op.expectedVersion,
        kind: op.kind,
        status: op.kind === 'script' ? 'final' : 'draft',
        turnId: op.turnId,
        sourceContentId: null
      });
      localStorage.removeItem(scriptKey);
      await library.refetch();
    } catch (cause) {
      if (SCRIPT_REJECTIONS.has(message(cause))) {
        localStorage.removeItem(scriptKey);
        setError('采用请求已明确拒绝（' + message(cause) + '），请刷新后核对最新版本。');
        await library.refetch();
      } else setError('采用结果待核实。完整原请求已保留；再次点击只会恢复这一次请求。');
    } finally {
      setVideoBusy(false);
    }
  }

  function storeVideo(op: VideoOperation) {
    localStorage.setItem(videoKey, JSON.stringify(op));
  }
  async function runVideo(initial: VideoOperation) {
    setVideoBusy(true);
    setError('');
    const op: VideoOperation = { ...initial, held: false };
    const rejected = async (notice: string) => {
      localStorage.removeItem(videoKey);
      setError(notice);
      await library.refetch();
    };
    const claim = {
      workItemId: op.workItemId,
      requestId: op.followup.requestId,
      sourceScriptId: op.sourceScriptId,
      choice: op.choice,
      expectedStoryboardVersion: op.package.expectedStoryboardVersion,
      expectedEditingVersion: op.package.expectedEditingVersion
    };
    try {
      storeVideo(op);
      await prepareVideo.mutateAsync(claim);
      const answer = await chat.send(op.followup.input, op.followup.requestId, { moduleId: op.moduleId, workItem: true });
      // A definite refusal stored nothing: release the claim, or the material stays held from every other message.
      if (answer === 'kept') {
        await prepareVideo.mutateAsync({ ...claim, action: 'abandon' });
        await rejected('');
        return;
      }
      const read = await chat.reload();
      const turnId = read && replyOfRequest(read.messages, op.followup.requestId);
      if (!turnId) {
        if (answer === 'done' && read && !read.activeTurn) {
          await rejected('这次生成没有完成，没有保存内容。可以重新选择。');
          return;
        }
        storeVideo({ ...op, held: true });
        setError('生成结果待核实。再次选择会用同一请求继续，不会重复扣费。');
        return;
      }
      await saveVideo.mutateAsync({ ...claim, turnId });
      localStorage.removeItem(videoKey);
      await library.refetch();
    } catch (cause) {
      if (VIDEO_REJECTIONS.has(message(cause))) {
        await rejected('视频工作请求已明确拒绝（' + message(cause) + '），请刷新后核对最新版本。');
      } else {
        storeVideo({ ...op, held: true });
        setError('视频工作请求状态待核实。完整原请求已保留；再次选择会用同一请求继续，不会新建请求。');
      }
    } finally {
      setVideoBusy(false);
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
  // After a reload: a frozen step resumes itself once, when no turn is running; one held for the user's choice waits for it.
  return { finalize, runVideo, setType, editItem };
}
