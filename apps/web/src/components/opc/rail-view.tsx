/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties, KeyboardEvent, ReactNode, Ref, SyntheticEvent } from 'react';
import Link from 'next/link';
import { ChevronDown, Ellipsis, Grid2X2, Pencil, Pin, Sparkles, X } from 'lucide-react';
import styles from './workspace-frame.module.css';

/**
 * Display-only parts of the workspace shell: the top bar, the announcement, and the left rail with its
 * function links, the platform / account / work list and the bottom widgets. They take data and callbacks
 * only (no queries, no sign-in); `WorkspaceFrame` owns the data, the open menus and the dialogs. The landing
 * page renders the same markup from the fixtures in `components/chat-display/fixtures/rail.ts`.
 */

export type RailArea = 'chat' | 'library' | 'topics' | 'marketplace' | 'search' | 'start' | 'review';
type Click = (event: SyntheticEvent<HTMLElement>) => void;

/** Top bar: logo, "首页 / 对话 / 个人中心", and the phone menu button. */
export function GlobalHeader({ area, onOpenNav }: { area: RailArea; onOpenNav?: () => void }) {
  return <header className={styles.global}>
    <Link href="/app" className={styles.brand}><img src="/graylum-logo.png" alt="" />Graylum</Link>
    <button type="button" className={styles.mobileGlobalMenu} aria-label="打开导航" onClick={onOpenNav}><Grid2X2 size={17}/></button>
    <nav aria-label="全局导航"><Link href="/app">首页</Link>
      <Link href="/app/positioning" aria-current={area==='chat'||area==='topics'||area==='start'?'page':undefined}>对话</Link>
      <Link href="/app/profile">个人中心</Link></nav>
  </header>;
}

/** The line under the top bar. `notice` is an environment note shown before the slogan. */
export function AnnouncementBar({ notice, returnParam = '', onClose }: { notice?: string; returnParam?: string; onClose?: () => void }) {
  return <div className={styles.announcement}>{notice&&<span>{notice}</span>}<Sparkles size={15}/><strong>让好想法，继续向前。</strong>
    <Link href={'/app/workbench/marketplace'+returnParam}>探索创作功能</Link>
    <button aria-label="关闭公告" onClick={onClose}><X size={15}/></button></div>;
}

/**
 * The left rail: new conversation, the function links, then `children` (RailHistory, RailNotices, RailBottom).
 * `returnParam` is the "?returnTo=…" the function pages use to come back. `launched` shows 发布排期 and 数据复盘
 * as available, like the other items, without "待接入": the landing page draws the product as launched (Owner
 * 2026-10-17); the product itself keeps them unavailable until publishing and the data review ship. `dataReview`
 * (PUBLISH-MONITOR PR-7) makes 数据复盘 a real link once the admin switch is on; 发布排期 stays unavailable.
 */
export function RailView({ area, returnParam = '', onCloseMobile, launched = false, dataReview = false, children }: {
  area: RailArea; returnParam?: string; onCloseMobile?: () => void; launched?: boolean; dataReview?: boolean;
  children: ReactNode;
}) {
  return <aside className={styles.rail} aria-label="工作区导航">
    <div className={styles.railMobile}><button aria-label="关闭导航" onClick={onCloseMobile}>关闭工作列表</button></div>
    <Link className={styles.newConversation} href="/app/positioning">
      <img className={styles.newConversationIcon} src="/opc-reference/new-chat.svg" alt=""/>新对话</Link>
    <nav className={styles.railNav} aria-label="工作区功能">
      <Link href={'/app/workbench/marketplace'+returnParam} aria-current={area==='marketplace'?'page':undefined}>
        <img className={styles.navIcon} src="/opc-reference/squares-four.svg" alt=""/>功能广场</Link>
      <Link href={'/app/workbench/search'+returnParam} aria-current={area==='search'?'page':undefined}>
        <img className={styles.navIcon} src="/opc-reference/magnifying-glass.svg" alt=""/>搜索</Link>
      <Link href={'/app/library'+returnParam} aria-current={area==='library'?'page':undefined}>
        <img className={styles.navIcon} src="/opc-reference/books.svg" alt=""/>资料库</Link>
      {launched ? <>
        {/* Shown as available, like the other items, but not controls: there is nothing to open yet (no href, not focusable). */}
        <a><img className={styles.navIcon} src="/opc-reference/calendar-blank.svg" alt=""/>发布排期</a>
        <a><img className={styles.navIcon} src="/opc-reference/chart-bar.svg" alt=""/>数据复盘</a>
      </> : <>
        <button disabled>
          <img className={styles.navIcon} src="/opc-reference/calendar-blank.svg" alt=""/>发布排期 <small>待接入</small></button>
        {dataReview ? <Link href={'/app/publish-monitor'+returnParam} aria-current={area==='review'?'page':undefined}>
          <img className={styles.navIcon} src="/opc-reference/chart-bar.svg" alt=""/>数据复盘</Link> : <button disabled>
          <img className={styles.navIcon} src="/opc-reference/chart-bar.svg" alt=""/>数据复盘 <small>待接入</small></button>}
      </>}
    </nav>
    {children}
  </aside>;
}

/** The scrolling list of platforms, accounts and work. `onControl` fires when the user takes over the scroll. */
export function RailHistory({ historyRef, archiveView, onToggleArchive, onControl, onScroll, children }: {
  historyRef?: Ref<HTMLDivElement>; archiveView: boolean; onToggleArchive?: () => void; onControl?: () => void;
  onScroll?: () => void; children: ReactNode;
}) {
  return <div ref={historyRef} className={styles.history} aria-label="平台、账号与工作" onPointerDownCapture={onControl} onWheelCapture={onControl}
    onTouchStartCapture={onControl} onKeyDownCapture={onControl} onScroll={onScroll}>
    <div className={styles.historyHead}><span>{archiveView?'归档记录':'平台 · 账号 · 工作'}</span>
      <button onClick={onToggleArchive}>{archiveView?'返回最近工作':'查看归档'}</button></div>
    {children}
  </div>;
}

/** A collapsible group: a platform, "对话" or "待归类". */
export function RailGroup({ title, open, onToggle, children }: {
  title: string; open: boolean; onToggle?: (open: boolean) => void; children: ReactNode;
}) {
  return <details open={open} onToggle={event=>onToggle?.(event.currentTarget.open)}>
    <summary>{title}<ChevronDown size={14}/></summary>{children}</details>;
}

/** An account inside a platform, with its inline rename. */
export function RailAccount({ name, open, onToggle, renaming, renameValue, onRenameValue, onStartRename, onSaveRename, onCancelRename, children }: {
  name: string; open: boolean; onToggle?: (open: boolean) => void; renaming: boolean; renameValue: string;
  onRenameValue?: (value: string) => void; onStartRename?: () => void; onSaveRename?: () => void; onCancelRename?: () => void;
  children: ReactNode;
}) {
  const key = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') onCancelRename?.();
    if (event.key === 'Enter') onSaveRename?.();
  };
  const press = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (renaming) onSaveRename?.(); else onStartRename?.();
  };
  return <details open={open} onToggle={event=>onToggle?.(event.currentTarget.open)} className={styles.account}>
    <summary>{renaming
      ?<input className={styles.accountRename} aria-label="重命名账号" maxLength={120} autoFocus value={renameValue}
        onClick={event=>event.stopPropagation()} onChange={event=>onRenameValue?.(event.target.value)} onKeyDown={key}/>
      :<span>{name}</span>}
      <button type="button" aria-label={renaming?'保存账号名称':'重命名账号 '+name} onClick={press}>{renaming?'✓':<Pencil size={14}/>}</button>
      <ChevronDown size={13}/></summary>
    {children}
  </details>;
}

/**
 * The "定位策略" row of an account. `confirmed` rows open the strategy overview (`statusLabel` is "当前 v2" or "已确认");
 * the others link to the unfinished positioning draft ("进行中").
 */
export function RailStrategyRow({ draftId, accountName, confirmed, statusLabel, reviewNote = '', onOpen, menuOpen, menuPosition, onOpenMenu, onView,
  opening = false, onBackToDiscussion }: {
  draftId: string; accountName: string; confirmed: boolean; statusLabel?: string; reviewNote?: string; onOpen?: () => void;
  menuOpen: boolean; menuPosition: CSSProperties; onOpenMenu?: Click; onView?: () => void; opening?: boolean; onBackToDiscussion?: () => void;
}) {
  const draftHref = '/app/positioning/' + draftId;
  return <div className={styles.strategyRow}>
    {confirmed
      ?<button type="button" className={styles.strategy} onClick={onOpen}>
        <span><Pin size={12}/>定位策略</span><small>{statusLabel} · {accountName}{reviewNote}</small></button>
      :<Link className={styles.strategy} href={draftHref}>
        <span><Pin size={12}/>定位策略</span><small>进行中 · {accountName}{reviewNote}</small></Link>}
    <button type="button" className={styles.strategyMore} aria-label="定位策略的更多操作" aria-expanded={menuOpen} onClick={onOpenMenu}>···</button>
    {menuOpen&&<div className={styles.workMenu} style={menuPosition} role="menu">
      {confirmed&&<button role="menuitem" onClick={onView}>查看或修改定位</button>}
      {confirmed
        ?<button role="menuitem" disabled={opening} onClick={onBackToDiscussion}>{opening?'正在打开…':'回到策略讨论'}</button>
        :<Link role="menuitem" href={draftHref}>回到策略讨论</Link>}
    </div>}</div>;
}

/** A small grey line in the list, e.g. "定位策略待建立". */
export function RailEmpty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/** "查看更早 N 项" under an account's work. */
export function RailOlder({ count, onClick }: { count: number; onClick?: () => void }) {
  return <button className={styles.older} onClick={onClick}>查看更早 {count} 项</button>;
}

/** One topic's conversation under an account: link or inline rename, and its "⋯" menu. */
export function RailWorkThread({ sessionId, name, pinned = false, dateLabel, active, renaming, renameValue, onRenameValue, onCancelRename, onSaveRename,
  menuOpen, menuPosition, onOpenMenu, archiveView, confirming, onRename, onPin, onArchive, onRestore, onRemove, onDeleteConversation,
  onDeleteArtifact }: {
  sessionId: string; name: string; pinned?: boolean; dateLabel: string; active: boolean; renaming: boolean; renameValue: string;
  onRenameValue?: (value: string) => void; onCancelRename?: () => void; onSaveRename?: () => void;
  menuOpen: boolean; menuPosition: CSSProperties; onOpenMenu?: Click; archiveView: boolean; confirming: boolean;
  onRename?: () => void; onPin?: () => void; onArchive?: () => void; onRestore?: () => void; onRemove?: () => void;
  onDeleteConversation?: () => void; onDeleteArtifact?: () => void;
}) {
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onCancelRename?.();
    if (event.key === 'Enter' && renameValue.trim()) onSaveRename?.();
  };
  return <div className={styles.threadRow}>
    {renaming
      ?<div className={styles.renameThread}>
        <input className={styles.inlineRename} autoFocus aria-label="重命名对话" maxLength={160} value={renameValue}
          onChange={event=>onRenameValue?.(event.target.value)} onKeyDown={key}/><small>{dateLabel} · 工作对话</small></div>
      :<Link className={styles.thread} aria-current={active?'page':undefined} href={'/app/runtime?session='+sessionId}>
        <span>{pinned&&<Pin size={12} aria-label="已置顶"/>}{name}</span><small>{dateLabel} · 工作对话</small></Link>}
    <button className={styles.more} aria-label={name+'的更多操作'} aria-expanded={menuOpen} onClick={onOpenMenu}><Ellipsis size={17}/></button>
    {menuOpen&&<div className={styles.workMenu} style={menuPosition} role="menu">
      <button role="menuitem" onClick={onRename}>重命名</button>
      {archiveView
        ?<button role="menuitem" onClick={onRestore}>恢复归档</button>
        :<><button role="menuitem" onClick={onPin}>{pinned?'取消置顶':'置顶'}</button><button role="menuitem" onClick={onArchive}>归档</button></>}
      <button role="menuitem" className={styles.danger} onClick={onRemove}>{confirming?'确认从列表移除（内容不删除）':'从列表移除'}</button>
      <button role="menuitem" className={styles.danger} onClick={onDeleteConversation}>
        永久删除对话记录</button>
      <button role="menuitem" className={styles.danger} onClick={onDeleteArtifact}>
        永久删除稿件与成果</button></div>}
  </div>;
}

/** Error or status lines under the list (rename, delete and discussion results). */
export function RailNotices({ items }: { items: Array<{ text: string; role: 'alert' | 'status' }> }) {
  return <>{items.map((item, index) => <p key={index} role={item.role} className={styles.uiError}>{item.text}</p>)}</>;
}

/** Feedback, credits and the account button at the bottom of the rail. */
export function RailBottom({ creditsLabel, creditsOpen, profileOpen, avatar, name, membership, onFeedback, onCredits, onProfile }: {
  creditsLabel: string | number | null; creditsOpen: boolean; profileOpen: boolean; avatar: string; name: string; membership: string;
  onFeedback?: Click; onCredits?: Click; onProfile?: Click;
}) {
  return <div className={styles.railBottom}><div className={styles.creditWidget}>
    <button type="button" onClick={onFeedback}><img className={styles.navIcon} src="/opc-reference/feedback.svg" alt=""/>在线反馈
      <img className={styles.externalIcon} src="/opc-reference/arrow-up-right.svg" alt=""/></button>
    <button type="button" aria-expanded={creditsOpen} onClick={onCredits}>
      <img className={styles.navIcon} src="/opc-reference/wallet-color.svg" alt=""/>积分 <small>{creditsLabel}</small></button></div>
    <button type="button" className={styles.profile} aria-expanded={profileOpen} onClick={onProfile}>
      <span className={styles.avatar}>{avatar}</span><span>{name}<small>{membership}</small></span><ChevronDown size={14}/></button></div>;
}
