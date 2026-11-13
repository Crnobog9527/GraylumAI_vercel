/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { trackedLink, type IntegrationModule } from '@/lib/integrations/catalog';
import type { ShotvivaState } from './use-shotviva';
import styles from './integrations.module.css';

/** One product's full introduction (a sheet on a phone): what it does, when to use or buy it, what connecting changes in
 * Graylum, the connection, and the two tracked links at the foot. */
export function IntegrationDetail({ module, open, onOpenChange, shotviva }: {
  module: IntegrationModule; open: boolean; onOpenChange: (open: boolean) => void; shotviva?: ShotvivaState;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.detail} aria-describedby={`${module.id}-tagline`}>
        <DialogTitle className={styles.detailTitle}>{module.name}</DialogTitle>
        <DialogDescription id={`${module.id}-tagline`} className={styles.tagline}>{module.tagline}</DialogDescription>
        <IntegrationDetailBody module={module} {...(shotviva ? { shotviva } : {})}/>
      </DialogContent>
    </Dialog>
  );
}

/** Everything under the title: the introduction, the connection and the two tracked links. */
export function IntegrationDetailBody({ module, shotviva }: { module: IntegrationModule; shotviva?: ShotvivaState }) {
  return <>
    <Section title="能做什么" lines={module.features}/>
    <Section title="什么时候适合用" lines={module.whenToUse}/>
    {module.inGraylum && <Section title="连接到 Graylum 以后" lines={module.inGraylum}/>}
    {module.connector === 'shotviva' && shotviva && <ShotvivaConnection shotviva={shotviva}/>}
    <div className={styles.links}>
      <a className={styles.secondary} href={trackedLink(module.viewUrl, module.id, 'view')} target="_blank" rel="noopener noreferrer">去查看</a>
      <a className={styles.primary} href={trackedLink(module.buyUrl, module.id, 'buy')} target="_blank" rel="noopener noreferrer">去购买</a>
    </div>
  </>;
}

function Section({ title, lines }: { title: string; lines: readonly string[] }) {
  return <section className={styles.section}><h3>{title}</h3><ul>{lines.map(line => <li key={line}>{line}</li>)}</ul></section>;
}

/** The connection inside the detail: connected (balance, top up, disconnect), or how to connect. */
function ShotvivaConnection({ shotviva }: { shotviva: ShotvivaState }) {
  const [confirming, setConfirming] = useState(false);
  const data = shotviva.status.data;
  if (shotviva.status.isLoading) return <div className={styles.connection} role="status">连接状态读取中…</div>;
  if (!data) return <div className={styles.connection} role="status">连接状态暂时读取不了，请稍后再试。</div>;
  if (data.connected) {
    return (
      <div className={styles.connection} data-connection="connected">
        <p><b>已连接</b>{data.balance ? `：剩余 ${data.balance.credits} 积分${data.balance.freeCredits ? `，另有 ${data.balance.freeCredits} 免费积分` : ''}`
          : '：剩余积分暂时读取不了'}</p>
        <div className={styles.connectionActions}>
          {data.balance && <a className={styles.secondary} href={data.balance.topUpUrl} target="_blank" rel="noopener noreferrer">去 Shotviva 充值</a>}
          {confirming
            ? <>
              <span className={styles.confirmText}>断开后，对话里就不能再用 Shotviva 出图了。</span>
              <button type="button" className={styles.danger} disabled={shotviva.disconnect.isPending}
                onClick={() => shotviva.disconnect.mutate(undefined, { onSettled: () => setConfirming(false) })}>确认断开</button>
              <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>取消</button>
            </>
            : <button type="button" className={styles.secondary} onClick={() => setConfirming(true)}>断开</button>}
        </div>
        {shotviva.disconnect.isError && <p role="alert" className={styles.error}>断开没有成功，请稍后再试。</p>}
      </div>
    );
  }
  if (!data.available) return <div className={styles.connection}><p><b>未连接</b>：连接暂未开放，可以先去 Shotviva 看看。</p></div>;
  if (!data.eligible) {
    return (
      <div className={styles.connection} data-connection="members">
        <p><b>未连接</b>：连接 Shotviva 是 Pro 和 Gold 会员的功能。</p>
        <Link prefetch={false} className={styles.secondary} href="/app/profile?tab=subscription">查看会员</Link>
      </div>
    );
  }
  return (
    <div className={styles.connection} data-connection="ready">
      <p><b>未连接</b>：连接后会跳到 Shotviva，登录（没有账号可以当场注册）并允许 Graylum 使用你的积分，然后回到这里。</p>
      <button type="button" className={styles.primary} disabled={shotviva.connecting} onClick={() => void shotviva.connect()}>
        {shotviva.connecting ? '正在前往 Shotviva…' : '连接 Shotviva'}</button>
      {shotviva.error && <p role="alert" className={styles.error}>{shotviva.error}</p>}
    </div>
  );
}
