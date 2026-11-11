'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  authorizeHere, captionTooLong, MAX_CAPTION, mediaProblem, newIdempotencyKey, platformName, publishErrorMessage, type Target,
} from '@/lib/publish-monitor/publish-flow';
import { clearAttempt, loadAttempt, saveAttempt, sameFiles, type StoredAttempt } from '@/lib/publish-monitor/publish-recovery';
import { mediaDigest, MediaUploadError, uploadPublishFiles } from '@/lib/publish-monitor/upload-media';
import { trpc } from '@/trpc/client';
import { MediaPicker, type PickedMedia } from './media-picker';
import styles from './publish.module.css';

/**
 * PUBLISH-MONITOR PR-5 (plan §2.1, §6): pick targets, files, cover and caption; nothing is uploaded until the user
 * confirms the disclosure. A submit whose answer was lost is retried with the same key and the same uploads (the
 * server replays it and never posts twice); every new attempt after a final failure uploads again with a new key.
 */
export function PublishForm({ businessId, workItemId, contextKey, targets, initialCaption, initialTargets, holdCreditsByTargets,
  onSubmitted, onPendingChange }: {
  // contextKey names this publish for the saved-attempt storage: the topic, or the saved result being published.
  businessId: string; workItemId: string | null; contextKey: string; targets: Target[]; initialCaption: string; initialTargets: string[];
  holdCreditsByTargets: number[] | null; onSubmitted: (jobId: string) => void;
  // Tells the page whether an earlier submit is still unconfirmed (the page then keeps the brand fixed).
  onPendingChange?: (pending: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initialTargets.filter(id => targets.some(t => t.id === id && t.ready)));
  const [caption, setCaption] = useState(initialCaption);
  const [media, setMedia] = useState<PickedMedia[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'submitting'>('idle');
  const [error, setError] = useState('');
  // A submit whose answer never arrived (lost answer, reload, crash): the next try reuses its key and uploads the files
  // again (an old media link is never reused). Storage keeps only the key and file identities (publish-recovery.ts).
  const [recovered, setRecovered] = useState<StoredAttempt | null>(null);
  useEffect(() => {
    const stored = loadAttempt(contextKey);
    if (stored) { setRecovered(stored); setSelected(stored.connectionIds); setCaption(stored.caption); }
  }, [contextKey]);
  // Pending from confirmation until a definite outcome: while uploading or submitting, and while a lost answer is unresolved.
  useEffect(() => { onPendingChange?.(recovered !== null || phase !== 'idle'); }, [recovered, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const uploadUrl = trpc.publishMonitor.publish.uploadUrl.useMutation();
  const submit = trpc.publishMonitor.publish.submit.useMutation();
  const utils = trpc.useUtils();

  const busy = phase !== 'idle';
  const chosen = targets.filter(t => selected.includes(t.id));
  // In recovery the saved request decides (its targets may be closed or disconnected by now); otherwise the current choice.
  const targetCount = recovered ? recovered.connectionIds.length : chosen.length;
  const hold = recovered ? recovered.maxHoldCredits : holdCreditsByTargets?.[chosen.length - 1] ?? null;
  const tooLong = captionTooLong(caption, chosen.map(t => t.platform));
  // The server counts UTF-16 units (z.string().max), so this does too.
  const tooLongForServer = caption.length > MAX_CAPTION;
  // While an earlier submit is unconfirmed, what is published cannot change: another key could post and charge twice.
  const locked = recovered !== null;
  const mediaIssue = recovered ? null : mediaProblem(chosen.map(t => t.platform), media.map(m => m.file.type.toLowerCase()));
  const canPublish = targetCount > 0 && hold !== null && caption.trim().length > 0 && !tooLongForServer && mediaIssue === null
    && !busy;
  const changed = <T,>(set: (value: T) => void) => (value: T) => { if (!locked) set(value); };
  // Shown with the accounts that can publish now first; the order decides nothing else.
  const listed = [...targets].sort((a, b) => Number(b.ready) - Number(a.ready));
  // In recovery the covers are the saved ones (they are part of the request), shown on the files picked again.
  const pick = (items: PickedMedia[]) => setMedia(recovered
    ? items.map((item, i) => ({ ...item, coverMs: recovered.media[i]?.coverMs ?? null })) : items);
  function discardEarlier() {
    clearAttempt(contextKey);
    setRecovered(null);
    setError('');
  }

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
    const ids = recovered?.connectionIds ?? chosen.map(t => t.id);
    let submitting = false;
    let sent: StoredAttempt | null = null;
    try {
      setPhase('uploading');
      if (recovered) {
        const files: Array<{ sha256: string; size: number; mimeType: string }> = [];
        for (const item of media) files.push({ sha256: await mediaDigest(item.file), size: item.file.size,
          mimeType: item.file.type.toLowerCase() });
        if (!sameFiles(recovered, files)) {
          setError('上一次提交还没有确认结果，请按原来的顺序选择同样的文件（名字和格式也要一样），或放弃上一次。');
          return;
        }
      }
      // A text-only post (X, Threads, LinkedIn, Bluesky, Facebook) uploads nothing.
      const uploaded = media.length === 0 ? [] : await uploadPublishFiles(media.map(m => m.file), async count =>
        uploadUrl.mutateAsync({ disclosureAccepted: true, count, connectionIds: ids,
          ...(recovered ? { idempotencyKey: recovered.key } : {}) }));
      const record: StoredAttempt = recovered ?? { key: newIdempotencyKey(), connectionIds: ids, caption, maxHoldCredits: hold ?? 0,
        media: uploaded.map((item, i) => ({ sha256: item.sha256, size: item.size, mimeType: item.mimeType,
          coverMs: media[i]!.coverMs })) };
      setPhase('submitting');
      saveAttempt(contextKey, record);
      submitting = true;
      sent = record;
      const job = await submit.mutateAsync({ idempotencyKey: record.key, businessId, workItemId, connectionIds: record.connectionIds,
        caption: record.caption, maxHoldCredits: record.maxHoldCredits, media: uploaded.map((item, i) => ({ ...item,
          ...(record.media[i]!.coverMs !== null && item.mimeType.startsWith('video/')
            ? { thumbnailTimestampMs: record.media[i]!.coverMs! } : {}) })) });
      discardEarlier();
      onSubmitted(job.id);
    } catch (cause) {
      if (cause instanceof MediaUploadError) {
        // Nothing was submitted by this try; an earlier unconfirmed submit (recovered) stays protected.
        setError(publishErrorMessage(cause.code));
      } else {
        const trpcError = cause as { message?: string; data?: { code?: string } };
        const httpCode = trpcError.data?.code;
        // Only a definite refusal of the submit itself means nothing was sent. Anything else (and any refusal of an
        // upload step) may follow a submit that reached the server, so the key stays and is replayed, never replaced.
        // The answers that can follow a job already created (switch paused, plan lapsed, account closed) are not definite.
        const mayHaveJob = ['PUBLISH_MONITOR_DISABLED', 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED', 'PUBLISH_MONITOR_ACCOUNT_CLOSED']
          .includes(trpcError.message ?? '');
        const definite = submitting && httpCode && httpCode !== 'INTERNAL_SERVER_ERROR' && httpCode !== 'TOO_MANY_REQUESTS'
          && !mayHaveJob;
        // The price was raised after the user confirmed: nothing was held; show the new maximum before asking again.
        if (trpcError.message === 'PUBLISH_MONITOR_PRICE_CHANGED') void utils.publishMonitor.publish.options.invalidate();
        if (definite) discardEarlier();
        else if (sent) setRecovered(sent);
        setError(publishErrorMessage(trpcError.message, httpCode));
      }
    } finally {
      setPhase('idle');
    }
  }

  return (
    <div className={styles.layout}>
      <div className={styles.steps}>
        <section aria-labelledby="targets" className={styles.card}>
          <h2 id="targets"><span className={styles.stepNumber} aria-hidden>1</span>发到哪些账号</h2>
          {targets.length === 0 ? (
            <div className={styles.steps}>
              <p className={styles.hint}>
                这个品牌还没有可以一键发布的账号：先在账号连接页连接海外平台账号；只显示已经开放一键发布的平台。</p>
              <div className={styles.rowActions}><Link className={styles.linkQuiet} href="/app/publish-monitor">去连接账号</Link></div>
            </div>
          ) : (
            <ul className={styles.accounts}>
              {listed.map(target => (
                <li key={target.id} className={styles.account} data-selected={selected.includes(target.id)} data-ready={target.ready}>
                  <span className={styles.tile} aria-hidden>{platformName(target.platform).slice(0, 1).toUpperCase()}</span>
                  <label>
                    <Checkbox checked={selected.includes(target.id)} disabled={!target.ready || busy || locked}
                      onCheckedChange={value => changed(setSelected)(value === true
                        // One account per platform: picking one replaces another account of the same platform.
                        ? [...selected.filter(id => targets.find(t => t.id === id)?.platform !== target.platform), target.id]
                        : selected.filter(id => id !== target.id))} />
                    {platformName(target.platform)}{target.displayHint ? ` · ${target.displayHint}` : ''}
                  </label>
                  {!target.ready && (authorizeHere(target.platform) && target.accountProjectId
                    ? <Button size="sm" variant="outline" disabled={busy} onClick={() => authorize(target)}>授权发布</Button>
                    : <span className={styles.accountNote}>还没授权发布：到<Link
                      href="/app/publish-monitor">数据复盘</Link>的“我的账号”里，在这个账号旁点“允许一键发布”。</span>)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="media" className={styles.card}>
          <h2 id="media"><span className={styles.stepNumber} aria-hidden>2</span>图片或视频<span className={styles.tag}>可不选</span></h2>
          <MediaPicker items={media} onChange={pick} disabled={busy} lockCover={locked} />
        </section>

        <section aria-labelledby="caption" className={styles.card}>
          <h2 id="caption"><span className={styles.stepNumber} aria-hidden>3</span>文案</h2>
          <Textarea className={styles.caption} aria-labelledby="caption" value={caption} disabled={busy || locked} rows={8} maxLength={MAX_CAPTION}
            onChange={event => changed(setCaption)(event.target.value)} />
          <div className={styles.count} data-over={tooLongForServer}>
            <span>{tooLong.length > 0 ? `文案超过了 ${tooLong.map(platformName).join('、')} 的字数上限，平台可能拒绝或截断。` : ''}</span>
            <span>{caption.length} / {MAX_CAPTION} 字</span>
          </div>
          {(tooLongForServer || (mediaIssue && chosen.length > 0)) && (
            <div className={styles.stack}>
              {tooLongForServer && <p role="alert" className={styles.error}>文案超过 {MAX_CAPTION} 字，请先删减再发布。</p>}
              {mediaIssue && chosen.length > 0 && <p role="alert" className={styles.error}>{mediaIssue}</p>}
            </div>
          )}
        </section>

        {locked && <div role="status" className={styles.note}>
          <p>上一次提交还没有确认结果，可能已经发出。为了不重复发布和扣费，现在不能改账号和文案：请{recovered
            ? (recovered.media.length > 0 ? '按原来的顺序选择同样的文件，' : '')+'再点一次发布' : '再点一次发布'}，系统会认出是同一次。</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={discardEarlier}>
            放弃上一次，重新开始（请先去平台确认是否已发出）</Button>
        </div>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </div>

      <aside className={styles.summary} aria-labelledby="summary">
        <h2 id="summary">发布摘要</h2>
        <dl>
          <div><dt>账号</dt><dd>{recovered ? `${targetCount} 个账号（和上一次相同）`
            : chosen.length > 0 ? chosen.map(t => platformName(t.platform)).join('、') : '还没有选'}</dd></div>
          <div><dt>素材</dt><dd>{media.length > 0 ? `${media.length} 个文件` : '不带图片或视频'}</dd></div>
        </dl>
        {hold !== null && targetCount > 0 && <p className={styles.hold}>
          最多 {hold} 积分，只按发布成功的平台扣，失败不扣</p>}
        <Button className={styles.primary} disabled={!canPublish} onClick={() => { setAccepted(false); setConfirming(true); }}>
          {phase === 'uploading' ? '正在上传素材……' : phase === 'submitting' ? '正在提交……'
            : recovered ? '再试一次（同一次发布，不会重复发）' : '发布'}</Button>
      </aside>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认发布</DialogTitle>
            <DialogDescription>
              发布到 {recovered ? `${targetCount} 个账号（和上一次相同）` : chosen.map(t => platformName(t.platform)).join('、')}，发出后在平台上公开可见；要删帖需要你自己去平台删除。
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
