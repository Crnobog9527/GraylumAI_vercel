/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef, type ReactNode, type Ref } from 'react';
import { ArrowUp, Box, FileText, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useMenuPlacement } from './menu-placement';
import styles from './work-composer.module.css';

/**
 * Display-only message box: the frame, tool buttons, menus and notes. `WorkComposer` owns the text,
 * the menus' state, file reading and the skill query, and renders this; the landing page renders it
 * with sample data and `ComposerTextPreview` in place of the live editor.
 */
export function ComposerView({
 rootRef,attachment,editor,referenceMenu,menu=null,disabled=false,reading=false,onToggleFiles,onPickFile,fileHint,fileInput,
 onToggleSkills,skillMenu,counter,skillName,sendDisabled=false,onSend,status,error,note,
}:{
 rootRef?:Ref<HTMLDivElement>;
 /** Shown inside the frame above the text, for example the docked question card. */
 attachment?:ReactNode;
 /** The text box: `ComposerEditor` in the product, `ComposerTextPreview` on the landing page. */
 editor:ReactNode;
 /** The open `@` picker or its notice. */
 referenceMenu?:ReactNode;
 menu?:'files'|'skills'|null;
 disabled?:boolean;
 /** Attachments are being read. */
 reading?:boolean;
 onToggleFiles?:()=>void;onPickFile?:()=>void;
 /** The line under "从文件添加", for example the file types the box accepts. */
 fileHint:string;
 /** The hidden file input. */
 fileInput?:ReactNode;
 onToggleSkills?:()=>void;
 /** Shown while `menu` is "skills": `SkillMenuView`. */
 skillMenu?:ReactNode;
 /** Shown near the limit as "length / max". */
 counter?:{length:number;max:number}|null;
 /** Name of the chosen skill. */
 skillName?:string;
 sendDisabled?:boolean;onSend?:()=>void;
 /** Progress and notices of the files being stored (under the box). */
 status?:ReactNode;
 error?:string;note?:string;
}){
 return <div ref={rootRef} className={styles.wrap}><div className={styles.composer}>
  {attachment&&<div className={styles.attachment}>{attachment}</div>}
  {editor}
  {referenceMenu}
  <div className={styles.tools}><div className={styles.toolLeft}>
   <div className={styles.menuAnchor}><button type="button" aria-label="添加资料" disabled={disabled||reading} aria-expanded={menu==='files'}
    onClick={onToggleFiles}><Plus size={19}/></button>{menu==='files'&&<div className={styles.menu} role="dialog" aria-label="添加资料">
    <button type="button" onClick={onPickFile}><FileText size={16}/> 从文件添加</button>
    <p>{fileHint}</p></div>}</div>
   {fileInput}
   <div className={styles.menuAnchor}><button type="button" aria-label="使用技能" disabled={disabled} aria-expanded={menu==='skills'}
    onClick={onToggleSkills}><Box size={18}/></button>{menu==='skills'&&skillMenu}</div>
  </div><div className={styles.toolRight}>{counter&&<span>{counter.length} / {counter.max}</span>}
  {skillName&&<span>{skillName}</span>}<ModelSlot/><button type="button" aria-label="发送" className={styles.send} disabled={sendDisabled}
   onClick={onSend}><ArrowUp size={18}/></button></div></div>
 </div>{status}{reading&&<p role="status" className={styles.note}>正在读取附件…</p>}{error&&<p role="alert" className={styles.note}>{error}</p>}
 {note&&<p className={styles.note}>{note}</p>}</div>;
}

export type SkillChoice={moduleId:string;name:string};

/** The "使用技能" panel. `status` replaces the list while it loads or fails. */
export function SkillMenuView({query,onQuery,onClose,status,skills,hint,onPick}:{
 query:string;onQuery?:(value:string)=>void;onClose?:()=>void;
 status?:ReactNode;skills:SkillChoice[];
 /** Second line of each skill, for example "加载到本对话，不自动发送". */
 hint:string;
 onPick?:(moduleId:string)=>void;
}){
 const menuRef=useRef<HTMLDivElement>(null),listRef=useRef<HTMLDivElement>(null);
 useMenuPlacement(menuRef,listRef,(status?'status':'list')+':'+skills.length);
 return <div ref={menuRef} className={styles.skillMenu} role="dialog" aria-label="使用技能">
  <div className={styles.skillHead}><strong>使用技能</strong>
  <button type="button" aria-label="关闭技能菜单" onClick={onClose}><X size={16}/></button></div>
  <label className={styles.skillSearch}><Search size={16}/><input aria-label="搜索技能" placeholder="搜索技能" value={query}
   onChange={event=>onQuery?.(event.target.value)}/></label>
  <div ref={listRef} className={styles.skillList}>
   {status??<>{skills.map(skill=><button type="button" key={skill.moduleId} onClick={()=>onPick?.(skill.moduleId)}>
   <span className={styles.skillGlyph}><Box size={16}/></span><span><strong>{skill.name}</strong><small>{hint}</small></span></button>)}
   {!skills.length&&<p>没有匹配的可用技能</p>}</>}</div>
  <div className={styles.skillFoot}><Link href="/app/workbench/marketplace">浏览功能广场</Link></div></div>;
}

/**
 * UI-MODEL (Owner 2026-10-03, plan §2.1 item 50): the model position stays in the box but only shows Auto.
 * Users cannot switch; the backend picks the model by purpose, the same for every plan. Plain text, not a control.
 */
export function ModelSlot(){
 return <span className={styles.model} title={MODEL_SLOT_HINT}>Auto<span className={styles.srOnly}>{'，'+MODEL_SLOT_HINT}</span></span>;
}
export const MODEL_SLOT_HINT='模型由系统按用途自动选择';

export type ReferenceChoice={id:string;label:string};

/** The `@` document picker. `status` replaces the list while it loads or fails. */
export function ReferenceMenuView({status,choices,highlighted=-1,onPick,footnote}:{
 status?:ReactNode;choices:ReferenceChoice[];highlighted?:number;onPick?:(index:number)=>void;
 /** The small line under the list: the per-message limit and what the AI does with the documents. */
 footnote:ReactNode;
}){
 return <div className={styles.referenceMenu} role="dialog" aria-label="引用资料库文档">
  {status ?? (choices.length ? <div role="listbox" aria-label="资料库文档">{choices.map((item, index) =>
   <button type="button" role="option" key={item.id} aria-selected={index === highlighted}
    onMouseDown={event => event.preventDefault()} onClick={() => onPick?.(index)}>
    <FileText size={15}/><span>{item.label}</span>
   </button>)}</div>
   : <p>没有匹配的已就绪文档</p>)}
  <small>{footnote}</small>
 </div>;
}

/** A message with inline references: plain strings and `{reference: label}` chips, in order, one paragraph per entry. */
export type ComposerPreviewParagraph=Array<string|{reference:string}>;

/**
 * A read-only picture of the text box with its content, for the landing page: the same classes as the live
 * editor (`.ProseMirror`, the `library-reference` chip), without the editing engine. With no text it shows
 * `placeholder` the way the live editor does; `caret` (for a message being typed) follows the last character.
 */
export function ComposerTextPreview({label='消息',paragraphs,placeholder,caret}:{
 label?:string;paragraphs:ComposerPreviewParagraph[];placeholder?:string;caret?:ReactNode;
}){
 const empty=paragraphs.every(parts=>parts.every(part=>part===''));
 return <div className={styles.editor}><div className="ProseMirror" role="textbox" aria-label={label} aria-multiline="true" aria-readonly="true">
  {empty?<p className="is-editor-empty" data-placeholder={placeholder}>{caret}</p>
   :paragraphs.map((parts,index)=><p key={index}>{parts.map((part,at)=>typeof part==='string'?part
   :<span key={at} className="library-reference" data-library-reference="">{'@'+part.reference}</span>)}
   {index===paragraphs.length-1?caret:null}</p>)}
 </div></div>;
}
