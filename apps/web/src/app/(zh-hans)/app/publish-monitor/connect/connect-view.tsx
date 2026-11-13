'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Check, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { connectErrorMessage } from '@/lib/publish-monitor-messages';
import { trpc } from '@/trpc/client';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import styles from '../publish/publish.module.css';
import phone from './connect-phone.module.css';

/**
 * PUBLISH-MONITOR PR-2b-2 confirmation page (plan §4.1): nothing is written until the user picks one account here.
 * Account details come only from the server's read of this user's own pending attempt.
 * The page sits in the workbench frame (page.tsx) and follows the signed-in baseline; it owns its scrolling.
 */
const PLATFORM_NAMES: Record<string, string> = { x: 'X', youtube: 'YouTube', tiktok: 'TikTok', tiktok_business: 'TikTok 商业号',
  instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn', pinterest: 'Pinterest', bluesky: 'Bluesky' };
const platformName = (p: string) => PLATFORM_NAMES[p] ?? p;
const DATA_PAGE = '/app/publish-monitor';

/** A finished or stopped state: what happened, and the way back to the data review page. */
function Message({ title, text, back = false, done = false }: { title: string; text: string; back?: boolean; done?: boolean }) {
  return (
    <div className={styles.state}>
      <span className={styles.stateIcon}>{done ? <Check size={20} aria-hidden /> : <CircleAlert size={20} aria-hidden />}</span>
      <h2>{title}</h2>
      <p>{text}</p>
      {back && <div className={styles.actions}><Link className={styles.linkPrimary} href={DATA_PAGE}>回到数据复盘</Link></div>}
    </div>
  );
}

function ConnectConfirm({ requestId, providerFailed, ownedElsewhere }: { requestId: string; providerFailed: boolean;
  ownedElsewhere: boolean }) {
  const pending = trpc.publishMonitor.connect.pending.useQuery({ requestId }, { retry: false, refetchOnWindowFocus: false });
  const confirm = trpc.publishMonitor.connect.confirm.useMutation();
  const cancel = trpc.publishMonitor.connect.cancel.useMutation();
  const [picked, setPicked] = useState<string | null>(null);
  const [autoTrack, setAutoTrack] = useState(false);

  if (confirm.data) return <Message title="连接成功" text="已连接。作品数据会在第一次读取完成后出现。" back done />;
  if (cancel.data) return <Message title="已取消" text="没有连接任何账号；这次授权导入的新账号会被清理。" back />;
  if (pending.isLoading) return <PageSkeleton rows={3} label="连接信息读取中" />;
  if (pending.error || !pending.data) return <Message title="无法继续" text={connectErrorMessage(pending.error?.message)} back />;

  const data = pending.data;
  const selectable = data.candidates.filter(c => c.kind !== 'unavailable');
  const publish = data.permissions.includes('posts');
  const busy = confirm.isPending || cancel.isPending;
  const failure = confirm.error ?? cancel.error;
  return (
    <section className={styles.card} aria-labelledby="connect-title">
      <h2 id="connect-title">确认要连接的账号</h2>
      <div className={styles.steps}>
        <p className={styles.hint}>
          挂到品牌账号：{data.target.businessName ?? '你的品牌'} · {platformName(data.target.platform)} · {data.target.accountKey}
          <br />权限：{publish ? '读取作品数据，并允许以后在你确认后一键发布' : '只读取作品数据（不会发布任何内容）'}
        </p>
        {providerFailed && <p className={styles.hint}>授权页报告没有完成授权。</p>}
        {ownedElsewhere && <p className={styles.hint}>
          这次带回的账号里，有的已被其他 Graylum 用户连接，没有列出。请联系对方，或换一个账号。</p>}
        {selectable.length === 0 ? <p className={styles.hint}>这次授权没有带回可以连接的账号，请重新连接或取消。</p> : (
          <fieldset className={`${styles.choices} ${phone.choices}`}>
            <legend>选择 1 个账号（没选的会从连接服务里删除）</legend>
            {data.candidates.map(c => (
              <label key={c.providerAccountId} className={`${styles.choice} ${phone.choice}`}>
                <input type="radio" name="account" value={c.providerAccountId} disabled={c.kind === 'unavailable' || busy}
                  checked={picked === c.providerAccountId} onChange={() => setPicked(c.providerAccountId)} />
                <span>{c.username ?? c.providerAccountId}</span>
                {c.kind === 'target' && <small>（当前已连接，确认后更新授权）</small>}
                {c.kind === 'unavailable' && <small>（不可用）</small>}
              </label>
            ))}
          </fieldset>
        )}
        <label className={`${styles.check} ${phone.check}`}>
          <Checkbox checked={autoTrack} onCheckedChange={v => setAutoTrack(v === true)} disabled={busy} />
          每天自动更新作品数据（不勾选时只在你手动刷新时读取）
        </label>
        {failure && <p role="alert" className={styles.error}>{connectErrorMessage(failure.message)}</p>}
        <div className={`${styles.rowActions} ${phone.actions}`}>
          <Button disabled={!picked || busy}
            onClick={() => picked && confirm.mutate({ requestId, providerAccountId: picked, autoTrack })}>确认连接</Button>
          <Button variant="outline" disabled={busy} onClick={() => cancel.mutate({ requestId })}>取消</Button>
        </div>
      </div>
    </section>
  );
}

export function ConnectView() {
  const params = useSearchParams();
  const requestId = params.get('request');
  const error = params.get('error');
  return (
    <main className={`${styles.page} ${phone.page}`}>
      <header className={styles.head}>
        <h1>连接账号</h1>
        <Link className={styles.back} href={DATA_PAGE}>← 回到数据复盘</Link>
      </header>
      <p className={styles.intro}>确认这次授权要连接哪个社媒账号。选好并确认之前，不会保存任何连接。</p>
      <div className={styles.body}>
        <div className={`${styles.column} ${styles.narrow}`}>
          {error || !requestId ? <Message title="无法继续" text={connectErrorMessage(error)} back />
            : <ConnectConfirm requestId={requestId} providerFailed={params.get('provider') === 'failed'}
              ownedElsewhere={params.get('ownedElsewhere') === '1'} />}
        </div>
      </div>
    </main>
  );
}
