/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Check, Image as ImageIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import sheet from '@/components/design/bottom-sheet.module.css';
import { trackedLink, type IntegrationModule, type IntegrationPicture, type IntegrationSample, type IntegrationUse } from '@/lib/integrations/catalog';
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
 * dialog with the product's mark and name in a head that stays put, the connection first, then what it does and when to use it,
 * said mostly by the product's own sample pictures, then what connecting changes in Graylum, and the one tracked link in a foot
 * that stays put. On a phone it is a sheet from the bottom edge (design/bottom-sheet.module.css). The words are the catalog's.
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
        <div className={styles.scroll} data-scrolls="">
          <DialogDescription id={`${module.id}-tagline`} className={styles.tagline}>{module.tagline}</DialogDescription>
          {module.philosophy && <p className={styles.philosophy}>{module.philosophy}</p>}
          <IntegrationDetailBody module={module} {...(shotviva ? { shotviva } : {})}/>
        </div>
        <IntegrationViewLink module={module} {...(shotviva ? { shotviva } : {})}/>
      </DialogContent>
    </Dialog>
  );
}

/** Under the product's own two paragraphs: the connection, then the introduction row by row, pictures before words. */
export function IntegrationDetailBody({ module, shotviva }: { module: IntegrationModule; shotviva?: ShotvivaState }) {
  const { showcase } = module;
  return <>
    {module.connector === 'shotviva' && shotviva && <ShotvivaConnection shotviva={shotviva} icon={module.icon}/>}
    <div className={styles.rows}>
      <section className={styles.row}>
        <h3>能做什么</h3>
        <div className={styles.what}>
          {/* The same thing twice: as the phone took it, and as a template gave it back. */}
          {showcase && <div className={styles.turn}>
            <Shot sample={showcase.before}/><ArrowRight className={styles.turnArrow} aria-hidden="true"/><Shot sample={showcase.after}/>
          </div>}
          <div className={styles.rowBody}><Lines lines={module.features} lead={!!showcase}/></div>
        </div>
      </section>
      <section className={styles.row}>
        <h3>什么时候适合用</h3>
        {showcase && <ul role="list" className={styles.uses}>{showcase.uses.map(use => <li key={use.label}><Use use={use}/></li>)}</ul>}
        <Lines lines={module.whenToUse}/>
      </section>
      {module.inGraylum && <section className={styles.row}>
        <h3>连接到 Graylum 以后</h3>
        <Lines lines={module.inGraylum}/>
      </section>}
    </div>
  </>;
}

/**
 * A sample picture. Each file is twice the size it is shown at and no more, and its box is kept by width and height before it
 * arrives. It is asked for only when it comes within a short scroll of what the dialog shows (Owner 2026-11-13: "要保证手机版的
 * 性能"): the browser's own loading="lazy" reaches thousands of pixels ahead, which in this dialog is every picture at once
 * (measured: all fourteen on opening a 390px sheet). Where the browser cannot watch for that, the picture is simply asked for.
 */
function Picture({ picture, size }: { picture: IntegrationPicture; size: readonly [number, number] }) {
  const image = useRef<HTMLImageElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !image.current) return;
    const watch = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setNear(true); },
      { root: image.current.closest('[data-scrolls]'), rootMargin: `${AHEAD}px 0px` });
    watch.observe(image.current);
    return () => watch.disconnect();
  }, [near]);
  return <img ref={image} src={near ? picture.src : BLANK} alt={picture.alt} width={size[0]} height={size[1]} decoding="async"/>;
}
/** How far ahead of what is shown a picture is fetched: about one row of them. */
const AHEAD = 160;
/** Nothing, one pixel of it: what a picture's box holds until the picture is asked for. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const LARGE = [336, 420] as const;
const SMALL = [200, 250] as const;

/** One sample picture with its few words under it. */
function Shot({ sample }: { sample: IntegrationSample }) {
  return <figure className={styles.shot}><Picture picture={sample} size={LARGE}/><figcaption>{sample.label}</figcaption></figure>;
}

/** One kind of use: the photo and what came of it in one frame, left to right, then its name and one line. */
function Use({ use }: { use: IntegrationUse }) {
  return (
    <figure className={styles.use}>
      <div className={styles.split} data-cutout={use.cutout ? 'true' : undefined}>
        <Picture picture={use.before} size={SMALL}/><Picture picture={use.after} size={SMALL}/>
        <ArrowRight className={styles.seam} aria-hidden="true"/>
      </div>
      <figcaption><b>{use.label}</b><span>{use.note}</span></figcaption>
    </figure>
  );
}

/** A row's lines; under two pictures the first is what the pictures show, said once, and the rest are the small print. */
function Lines({ lines, lead = false }: { lines: readonly string[]; lead?: boolean }) {
  if (!lead) return <ul role="list">{lines.map(line => <li key={line}>{line}</li>)}</ul>;
  return <>{lines.map((line, index) => <p key={line} className={index === 0 ? styles.lead : styles.fine}>{line}</p>)}</>;
}

/** Whether the dialog's own next step is to connect (a member, the connector on, not connected yet). */
const canConnect = (shotviva?: ShotvivaState) => {
  const data = shotviva?.status.data;
  return !!data && !data.connected && data.available && data.eligible;
};

/**
 * The tracked link to the product's own page, at the foot (Owner 2026-11-13: "只保留'去查看'"; there is no 去购买). One dark
 * action per dialog (DESIGN.md "Buttons and actions"): 去查看 is it, except while the dialog offers 连接, which then is.
 */
export function IntegrationViewLink({ module, shotviva }: { module: IntegrationModule; shotviva?: ShotvivaState }) {
  return (
    <footer className={`${styles.links} ${sheet.bar}`}>
      <a className={canConnect(shotviva) ? styles.secondary : styles.primary} href={trackedLink(module.viewUrl, module.id)}
        target="_blank" rel="noopener noreferrer">去查看<NewTab/></a>
    </footer>
  );
}
/** These links leave Graylum for a new tab. */
const NewTab = () => <ArrowUpRight size={15} aria-hidden="true"/>;

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
          {/* Both kinds by name, a zero as well (Owner 2026-11-13: a bare "3 积分" did not say they were the paid ones). */}
          <p><b>已连接</b>{data.balance
            ? <>：付费积分 <strong>{data.balance.credits}</strong> · 免费积分 <strong>{data.balance.freeCredits}</strong></>
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
