'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { trpc } from '@/trpc/client';
import { imageActionHref, imageCardMessage } from '@/lib/integrations/shotviva-messages';
import type { ReplyStep } from './turn-step-list-model';
import styles from './image-step-cards.module.css';

/** INTEGRATION-SHOTVIVA: under a reply, one card per image step: the image (through Graylum, see the image route), or why it
 * was not made with the one button that helps. Live and after a reload the same: the step holds the job, the card reads it. */
export function ImageStepCards({ steps }: { steps: readonly ReplyStep[] }) {
  const images = steps.filter(step => step.tool === 'image' && step.state !== 'running');
  if (!images.length) return null;
  return <div className={styles.cards}>{images.map(step => <ImageStepCard key={step.id} step={step}/>)}</div>;
}

const POLL_MS = 10_000;

function ImageStepCard({ step }: { step: ReplyStep }) {
  const pending = step.reason === 'running';
  const made = step.state === 'done' && Boolean(step.job);
  const job = trpc.connectors.shotvivaImage.useQuery({ jobId: step.job ?? '' }, {
    enabled: made || (pending && Boolean(step.job)), staleTime: 5 * 60_000, retry: 1,
    // A job still generating is asked again until it ends (Shotviva may finish after the reply).
    refetchInterval: query => query.state.data?.status === 'running' ? POLL_MS : false,
  });
  const quota = step.reason === 'quota_exhausted';
  const status = trpc.connectors.shotvivaStatus.useQuery(undefined, { enabled: quota, staleTime: 60_000, retry: 0 });
  const data = job.data;
  if (data?.status === 'succeeded' && step.job) {
    return (
      <figure className={styles.card} data-image-card="image">
        <img className={styles.image} src={`/api/connectors/shotviva/image?job=${encodeURIComponent(step.job)}`}
          alt="用 Shotviva 生成的图片" loading="lazy" decoding="async"/>
        <figcaption className={styles.caption}>
          <span>由 Shotviva 生成，用的是你的 Shotviva 积分</span>
          <a href={data.viewUrl} target="_blank" rel="noopener noreferrer">在 Shotviva 查看</a>
        </figcaption>
      </figure>
    );
  }
  if (made && job.isLoading) return <div className={styles.card} data-image-card="loading" role="status">图片读取中…</div>;
  // A finished job read back as failed, a still-running one, or a step that was never made.
  const reason = data?.status === 'failed' ? data.code : data?.status === 'running' ? 'running' : made && job.isError ? 'unavailable'
    : step.reason;
  const message = imageCardMessage(reason);
  const href = message.action ? imageActionHref(message.action, { topUpUrl: status.data?.balance?.topUpUrl ?? null,
    viewUrl: data && 'viewUrl' in data ? data.viewUrl : null }) : null;
  const external = href !== null && /^https:\/\//.test(href);
  return (
    <div className={styles.card} data-image-card="notice" data-image-reason={reason ?? 'unavailable'} role="status">
      <p className={styles.text}>{message.text}</p>
      {message.action && href && <a className={styles.action} href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{message.action.label}</a>}
    </div>
  );
}
