'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  authorizeHere, captionTooLong, newIdempotencyKey, platformName, publishErrorMessage, type Target,
} from '@/lib/publish-monitor/publish-flow';
import { MediaUploadError, uploadPublishFiles, type UploadedMedia } from '@/lib/publish-monitor/upload-media';
import { trpc } from '@/trpc/client';
import { MediaPicker, type PickedMedia } from './media-picker';

/**
 * PUBLISH-MONITOR PR-5 (plan §2.1, §6): pick targets, files, cover and caption; nothing is uploaded until the user
 * confirms the disclosure. A submit whose answer was lost is retried with the same key and the same uploads (the
 * server replays it and never posts twice); every new attempt after a final failure uploads again with a new key.
 */
type Attempt = { key: string; media: UploadedMedia[]; covers: Array<number | null> };

export function PublishForm({ businessId, workItemId, targets, initialCaption, initialTargets, holdCreditsByTargets,
  onSubmitted }: {
  businessId: string; workItemId: string | null; targets: Target[]; initialCaption: string; initialTargets: string[];
  holdCreditsByTargets: number[] | null; onSubmitted: (jobId: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initialTargets.filter(id => targets.some(t => t.id === id && t.ready)));
  const [caption, setCaption] = useState(initialCaption);
  const [media, setMedia] = useState<PickedMedia[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'submitting'>('idle');
  const [error, setError] = useState('');
  // Kept only in memory for one attempt; never written to storage or logs.
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const uploadUrl = trpc.publishMonitor.publish.uploadUrl.useMutation();
  const submit = trpc.publishMonitor.publish.submit.useMutation();

  const busy = phase !== 'idle';
  const chosen = targets.filter(t => selected.includes(t.id));
  const hold = holdCreditsByTargets?.[chosen.length - 1] ?? null;
  const tooLong = captionTooLong(caption, chosen.map(t => t.platform));
  const canPublish = chosen.length > 0 && caption.trim().length > 0 && !busy;
  // Any change to what is published makes the next confirmation a new attempt with fresh uploads.
  const changed = <T,>(set: (value: T) => void) => (value: T) => { setAttempt(null); set(value); };

  async function authorize(target: Target) {
    setError('');
    const response = await fetch('/api/publish-monitor/connect/start', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountProjectId: target.accountProjectId, publish: true }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { url?: string; error?: string } | null;
    if (response?.ok && body?.url) window.location.assign(body.url);
    else setError(publishErrorMessage(body?.error));
  }

  async function publish() {
    setConfirming(false);
    setError('');
    let current = attempt;
    try {
      if (!current) {
        setPhase('uploading');
        // A text-only post (X, Threads, LinkedIn, Bluesky, Facebook) uploads nothing.
        const uploaded = media.length === 0 ? [] : await uploadPublishFiles(media.map(m => m.file), async count =>
          uploadUrl.mutateAsync({ disclosureAccepted: true, count, connectionIds: chosen.map(t => t.id) }));
        current = { key: newIdempotencyKey(), media: uploaded, covers: media.map(m => m.coverMs) };
        setAttempt(current);
      }
      setPhase('submitting');
      const job = await submit.mutateAsync({ idempotencyKey: current.key, businessId, workItemId,
        connectionIds: chosen.map(t => t.id), caption,
        media: current.media.map((item, i) => ({ ...item,
          ...(current!.covers[i] !== null && item.mimeType.startsWith('video/') ? { thumbnailTimestampMs: current!.covers[i]! } : {}) })),
      });
      setAttempt(null);
      onSubmitted(job.id);
    } catch (cause) {
      if (cause instanceof MediaUploadError) {
        setAttempt(null);
        setError(publishErrorMessage(cause.code));
      } else {
        const trpcError = cause as { message?: string; data?: { code?: string } };
        // A definite refusal means nothing was sent: the next try is a new attempt. Anything else may have reached the
        // server, so the same attempt (same key, same uploads) is replayed and can never post twice.
        const httpCode = trpcError.data?.code;
        if (httpCode && httpCode !== 'INTERNAL_SERVER_ERROR' && httpCode !== 'TOO_MANY_REQUESTS') setAttempt(null);
        setError(publishErrorMessage(trpcError.message, httpCode));
      }
    } finally {
      setPhase('idle');
    }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="targets" className="space-y-2">
        <h2 id="targets" className="font-medium">发到哪些账号</h2>
        {targets.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">
            这个品牌还没有可以一键发布的账号：先在账号连接页连接海外平台账号；只显示已经开放一键发布的平台。</p>
        ) : (
          <ul className="space-y-2">
            {targets.map(target => (
              <li key={target.id} className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox checked={selected.includes(target.id)} disabled={!target.ready || busy}
                    onCheckedChange={value => changed(setSelected)(value === true ? [...selected, target.id]
                      : selected.filter(id => id !== target.id))} />
                  {platformName(target.platform)}{target.displayHint ? ` · ${target.displayHint}` : ''}
                </label>
                {!target.ready && (authorizeHere(target.platform) && target.accountProjectId
                  ? <Button size="sm" variant="outline" disabled={busy} onClick={() => authorize(target)}>授权发布</Button>
                  : <span className="text-[var(--text-secondary)]">还没授权发布：请在账号连接页重新连接这个账号，并选择允许发布。</span>)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="media" className="space-y-2">
        <h2 id="media" className="font-medium">图片或视频</h2>
        <MediaPicker items={media} onChange={changed(setMedia)} disabled={busy} />
      </section>

      <section aria-labelledby="caption" className="space-y-2">
        <h2 id="caption" className="font-medium">文案</h2>
        <Textarea aria-labelledby="caption" value={caption} disabled={busy} rows={8} maxLength={5000}
          onChange={event => changed(setCaption)(event.target.value)} />
        {tooLong.length > 0 && <p className="text-sm text-[var(--text-secondary)]">
          文案超过了 {tooLong.map(platformName).join('、')} 的字数上限，平台可能拒绝或截断。</p>}
      </section>

      {error && <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p>}
      <div className="flex items-center gap-3">
        <Button disabled={!canPublish} onClick={() => { setAccepted(false); setConfirming(true); }}>
          {phase === 'uploading' ? '正在上传素材……' : phase === 'submitting' ? '正在提交……'
            : attempt ? '再试一次（同一次发布，不会重复发）' : '发布'}</Button>
        {hold !== null && chosen.length > 0 && <span className="text-sm text-[var(--text-secondary)]">
          最多 {hold} 积分，只按发布成功的平台扣，失败不扣</span>}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认发布</DialogTitle>
            <DialogDescription>
              发布到 {chosen.map(t => platformName(t.platform)).join('、')}，发出后在平台上公开可见；要删帖需要你自己去平台删除。
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {hold !== null && <li>先冻结最多 {hold} 积分，结果确定后只按发布成功的平台扣，其余退回。</li>}
            {media.length > 0 && <>
              <li>素材会上传到第三方发布服务 Post for Me，再由它发到各平台。</li>
              <li>发布期间素材是公开链接，拿到链接的人能看到。</li>
              <li>发布成功后对方会删除素材；发布失败或没用上的素材，对方约一天内自动清理，我们无法提前删除。</li>
            </>}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={accepted} onCheckedChange={value => setAccepted(value === true)} />
            我已了解，确认发布
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>取消</Button>
            <Button disabled={!accepted} onClick={publish}>确认发布</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
