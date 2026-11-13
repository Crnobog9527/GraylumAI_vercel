/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, Image as ImageIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import sheet from '@/components/design/bottom-sheet.module.css';
import { trackedLink, type IntegrationModule } from '@/lib/integrations/catalog';
import type { ShotvivaState } from './use-shotviva';
import styles from './integrations.module.css';

/** A product's own mark (the card and the head of its introduction); a product without one gets the plain picture icon. */
export function IntegrationIcon({ module }: { module: IntegrationModule }) {
  // The mark is decoration beside the product's name, which is always written next to it.
  return module.icon ? <img className={styles.mark} src={module.icon} alt="" width={96} height={96}/>
    : <i className={styles.mark} aria-hidden="true"><ImageIcon /></i>;
}

/**
 * One product's full introduction (Owner 2026-11-13: redesigned to the signed-in dialog of DESIGN.md "Light foundation"): a white
 * dialog with the product's mark and name in a head that stays put, the connection first, then what it does, when to use or buy
 * it and what connecting changes in Graylum, and the two tracked links in a foot that stays put. On a phone it is a sheet from
 * the bottom edge (design/bottom-sheet.module.css). The words are the catalog's and are not changed here.
 */
export function IntegrationDetail({ module, open, onOpenChange, shotviva }: {
  module: IntegrationModule; open: boolean; onOpenChange: (open: boolean) => void; shotviva?: ShotvivaState;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent tone="light" className={`${styles.detail} ${sheet.panel} ${sheet.anchored}`} aria-describedby={`${module.id}-tagline`}>
        <header className={styles.head}>
          <IntegrationIcon module={module}/>
          <DialogTitle className={styles.detailTitle}>{module.name}</DialogTitle>
        </header>
        <div className={styles.scroll}>
          <DialogDescription id={`${module.id}-tagline`} className={styles.tagline}>{module.tagline}</DialogDescription>
          {module.philosophy && <p className={styles.philosophy}>{module.philosophy}</p>}
          <IntegrationDetailBody module={module} {...(shotviva ? { shotviva } : {})}/>
        </div>
        <IntegrationLinks module={module} {...(shotviva ? { shotviva } : {})}/>
      </DialogContent>
    </Dialog>
  );
}

/** Under the product's own two paragraphs: the connection, then the introduction row by row. */
export function IntegrationDetailBody({ module, shotviva }: { module: IntegrationModule; shotviva?: ShotvivaState }) {
  return <>
    {module.connector === 'shotviva' && shotviva && <ShotvivaConnection shotviva={shotviva} icon={module.icon}/>}
    <div className={styles.rows}>
      <Row title="能做什么" lines={module.features}/>
      <Row title="什么时候适合用" lines={module.whenToUse}/>
      {module.inGraylum && <Row title="连接到 Graylum 以后" lines={module.inGraylum}/>}
    </div>
  </>;
}

/** Whether the dialog's own next step is to connect (a member, the connector on, not connected yet). */
const canConnect = (shotviva?: ShotvivaState) => {
  const data = shotviva?.status.data;
  return !!data && !data.connected && data.available && data.eligible;
};

/**
 * The two tracked links to the product's own pages, at the foot. One dark action per dialog (DESIGN.md "Buttons and actions"):
 * 去购买 is it, except while the dialog offers 连接, which then is.
 */
export function IntegrationLinks({ module, shotviva }: { module: IntegrationModule; shotviva?: ShotvivaState }) {
  return (
    <footer className={`${styles.links} ${sheet.bar}`}>
      <a className={styles.secondary} href={trackedLink(module.viewUrl, module.id, 'view')} target="_blank" rel="noopener noreferrer">去查看<NewTab/></a>
      <a className={canConnect(shotviva) ? styles.secondary : styles.primary} href={trackedLink(module.buyUrl, module.id, 'buy')}
        target="_blank" rel="noopener noreferrer">去购买<NewTab/></a>
    </footer>
  );
}
/** These links leave Graylum for a new tab. */
const NewTab = () => <ArrowUpRight size={15} aria-hidden="true"/>;

function Row({ title, lines }: { title: string; lines: readonly string[] }) {
  return <section className={styles.row}><h3>{title}</h3><ul role="list">{lines.map(line => <li key={line}>{line}</li>)}</ul></section>;
}

/** Graylum and the product side by side, with what is between them: a broken line, or a joined one once connected. */
function Pair({ icon, linked = false }: { icon?: string; linked?: boolean }) {
  return (
    <span className={styles.pair} data-linked={linked} aria-hidden="true">
      <img src="/graylum-logo.png" alt="" width={64} height={64}/>
      <span className={styles.wire}>{linked && <Check strokeWidth={3}/>}</span>
      {icon ? <img src={icon} alt="" width={64} height={64}/> : <i/>}
    </span>
  );
}

/** The connection inside the detail: connected (balance, top up, disconnect), or how to connect. */
function ShotvivaConnection({ shotviva, icon }: { shotviva: ShotvivaState; icon?: string }) {
  const [confirming, setConfirming] = useState(false);
  const data = shotviva.status.data;
  const pair = <Pair linked={!!data?.connected} {...(icon ? { icon } : {})}/>;
  if (shotviva.status.isLoading) return <div className={styles.connection} role="status">{pair}<p>连接状态读取中…</p></div>;
  if (!data) return <div className={styles.connection} role="status">{pair}<p>连接状态暂时读取不了，请稍后再试。</p></div>;
  if (data.connected) {
    return (
      <div className={styles.connection} data-connection="connected">
        {pair}
        <div className={styles.connectionBody}>
          <p><b>已连接</b>{data.balance ? `：剩余 ${data.balance.credits} 积分${data.balance.freeCredits ? `，另有 ${data.balance.freeCredits} 免费积分` : ''}`
            : '：剩余积分暂时读取不了'}</p>
          <div className={styles.connectionActions}>
            {data.balance?.topUpUrl && <a className={styles.secondary} href={data.balance.topUpUrl} target="_blank" rel="noopener noreferrer">
              去 Shotviva 充值<NewTab/></a>}
            {confirming
              ? <>
                <span className={styles.confirmText}>断开后，对话里就不能再用 Shotviva 出图了。</span>
                <button type="button" className={styles.danger} disabled={shotviva.disconnect.isPending}
                  onClick={() => shotviva.disconnect.mutate(undefined, { onSettled: () => setConfirming(false) })}>确认断开</button>
                <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>取消</button>
              </>
              : <button type="button" className={styles.quiet} onClick={() => setConfirming(true)}>断开</button>}
          </div>
          {shotviva.disconnect.isError && <p role="alert" className={styles.error}>断开没有成功，请稍后再试。</p>}
        </div>
      </div>
    );
  }
  if (!data.available) {
    return <div className={styles.connection}>{pair}<p><b>未连接</b>：连接暂未开放，可以先去 Shotviva 看看。</p></div>;
  }
  if (!data.eligible) {
    return (
      <div className={styles.connection} data-connection="members">
        {pair}
        <div className={styles.connectionBody}>
          <p><b>未连接</b>：连接 Shotviva 是 Pro 和 Gold 会员的功能。</p>
          <div className={styles.connectionActions}>
            <Link prefetch={false} className={styles.secondary} href="/app/profile?tab=subscription">查看会员</Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.connection} data-connection="ready">
      {pair}
      <div className={styles.connectionBody}>
        <p><b>未连接</b>：连接后会跳到 Shotviva，登录（没有账号可以当场注册）并允许 Graylum 使用你的积分，然后回到这里。</p>
        <div className={styles.connectionActions}>
          <button type="button" className={styles.primary} disabled={shotviva.connecting} onClick={() => void shotviva.connect()}>
            {shotviva.connecting ? '正在前往 Shotviva…' : '连接 Shotviva'}</button>
        </div>
        {shotviva.error && <p role="alert" className={styles.error}>{shotviva.error}</p>}
      </div>
    </div>
  );
}
