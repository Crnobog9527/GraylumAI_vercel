/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode, Ref } from 'react';
import styles from './content-editor.module.css';

/**
 * Display-only right column of a topic ("正文稿件"). `ContentEditor` keeps the draft, saving and
 * dialogs and renders this; the landing page can render it with sample text and no callbacks.
 */
export function ContentDraftView({
 platform,account,contentLabel,unavailable=false,title,body,onTitle,onBody,versionLine,saved,error,
 rebaseVersion,onRebase,pending=false,recoverDisabled=false,onRecover,expandRef,onExpand,historyRef,onHistory,onErase,
 finalizeDisabled=false,onFinalize,children,overlay,
}:{
 platform:string;account:string;
 /** 口播稿 / 图文 / 文章. */
 contentLabel:string;
 /** The source is gone: no fields, only the notice. */
 unavailable?:boolean;
 title:string;body:string;
 onTitle?:(value:string)=>void;onBody?:(value:string)=>void;
 /** For example "账号已保存 v2 · 草稿". */
 versionLine:string;
 saved?:string;error?:string;
 /** A newer server version the draft may be rebased on. */
 rebaseVersion?:number|null;onRebase?:()=>void;
 /** A save waits for recovery. */
 pending?:boolean;recoverDisabled?:boolean;onRecover?:()=>void;
 expandRef?:Ref<HTMLButtonElement>;onExpand?:()=>void;
 historyRef?:Ref<HTMLButtonElement>;onHistory?:()=>void;
 /** Present when there is a saved version to delete. */
 onErase?:()=>void;
 finalizeDisabled?:boolean;onFinalize?:()=>void;
 /** Shown under the actions, for example storyboard and editing results. */
 children?:ReactNode;
 /** Dialogs rendered after the footer. */
 overlay?:ReactNode;
}){
 return <div className={styles.editor}>
  <header><p className={styles.label}>正文稿件</p><p className={styles.meta}>{platform} · {account} · {contentLabel}</p></header>
  <div className={styles.body}>
   {unavailable?<p role="alert">来源已不可用，不能编辑或保存这条工作。</p>:<>
    <label>稿件标题<input aria-label="稿件标题" value={title} onChange={event=>onTitle?.(event.target.value)} maxLength={160}/></label>
    <label>{contentLabel+'正文'}<textarea aria-label={contentLabel+'正文'} value={body} onChange={event=>onBody?.(event.target.value)} maxLength={20000}
     placeholder="先写下草稿，保存后会形成可找回的版本。"/></label>
    <p className={styles.version}>{versionLine}</p>
    {saved&&<p role="status" className={styles.success}>{saved}</p>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {rebaseVersion!=null&&<button className={styles.rebase} onClick={onRebase}>已比较历史，基于服务端 v{rebaseVersion} 保留我的编辑</button>}
    <div className={styles.actions}>
     {pending&&<button onClick={onRecover} disabled={recoverDisabled}>恢复草稿同步</button>}
     <button ref={expandRef} onClick={onExpand}>展开编辑</button>
     <button ref={historyRef} onClick={onHistory}>历史版本</button>
     {onErase&&<button onClick={onErase}>永久删除稿件</button>}
    </div>
    {children}
   </>}
  </div>
  <footer><button className={styles.primary} onClick={onFinalize} disabled={finalizeDisabled}>确认定稿{contentLabel}</button>
   <p>修改会自动同步为草稿；定稿会另存正式版本，不等于发布。</p></footer>
  {overlay}
 </div>;
}
