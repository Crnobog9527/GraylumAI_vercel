'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ContentVersion } from './content-editor';
import styles from './version-compare.module.css';

function VersionPane({version, side}:{version:ContentVersion|null;side:string}){
 return <section className={styles.pane} aria-label={side+'版本'}><header><span>{side}</span><strong>{version?`v${version.version} · ${version.status==='final'?'已定稿':'草稿'}`:'请选择版本'}</strong></header><div className={styles.content}>{version?<><p className={styles.field}>标题</p><h3>{version.title||'沿用选题标题'}</h3><p className={styles.field}>正文</p><div className={styles.body}>{version.contentAvailable===false?'来源已不可用，正文暂不展示。':version.body}</div></>:<p className={styles.empty}>选择下方版本后在这里查看。</p>}</div></section>;
}

export function VersionCompare({versions,onClose,returnFocusRef}:{versions:ContentVersion[];onClose:()=>void;returnFocusRef?:RefObject<HTMLButtonElement|null>}){
 const [opener]=useState(()=>typeof document==='undefined'?null:document.activeElement as HTMLElement|null);
 const [left,setLeft]=useState(versions[1]?.id??versions[0]?.id??'');
 const [right,setRight]=useState(versions.length>1?versions[0].id:'');
 return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Overlay className={styles.backdrop}><Dialog.Content aria-label="历史版本" aria-describedby={undefined} className={styles.dialog} onCloseAutoFocus={event=>{event.preventDefault();(returnFocusRef?.current??opener)?.focus();}}>
  <header className={styles.heading}><div><Dialog.Title asChild><h2>历史版本</h2></Dialog.Title><p>从下方列表选择版本，左右并排查看。</p></div><button type="button" aria-label="关闭历史版本" onClick={onClose}><X size={18}/></button></header>
  <div className={styles.columns}><VersionPane version={versions.find(version=>version.id===left)??null} side="左侧"/><VersionPane version={versions.find(version=>version.id===right)??null} side="右侧"/></div>
  <section className={styles.picker}><h3>选择对比版本 <small>{versions.length} 个已保存版本</small></h3><div className={styles.list}>{versions.length?versions.map(version=><div key={version.id} className={styles.row}><span>v{version.version}</span><span className={styles.title}>{version.title||'选题标题'} · {version.status==='final'?'已定稿':'草稿'}</span><button aria-pressed={left===version.id} disabled={right===version.id} onClick={()=>setLeft(version.id)}>放左侧</button><button aria-pressed={right===version.id} disabled={left===version.id} onClick={()=>setRight(version.id)}>放右侧</button></div>):<p>还没有已保存版本。</p>}</div></section>
  <footer className={styles.footer}><span>仅查看已保存的版本，不会更改当前内容。</span><button onClick={onClose}>完成查看</button></footer>
 </Dialog.Content></Dialog.Overlay></Dialog.Root>;
}
