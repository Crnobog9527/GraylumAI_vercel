'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BookOpen, Grid2X2, LogOut, Menu, PanelRightClose, Sparkles, UserRound, X } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { useCreditsBalance } from '@/hooks/use-credits';
import { createClient } from '@/lib/supabase';
import { buildAppHref } from '@/lib/site-config';
import { membershipText } from '@/lib/account-presentation';
import { StrategyOverviewDialog } from './strategy-overview-dialog';
import { ContentErasureDialog } from './content-erasure-dialog';
import { ConversationDeleteDialog } from './conversation-delete-dialog';
import { ConversationRow } from './conversation-row';
import { DraftRow, type UnassignedDraft } from './draft-row';
import { draftMark, latestByDraft } from '@/components/fusion-review/review-adapter';
import { useConversationRename } from '@/hooks/use-conversation-rename';
import { useConversationErasure } from '@/hooks/use-conversation-erasure';
import { useContentErasureSync } from '@/hooks/use-content-erasure';
import type { ContentErasureTarget } from '@/lib/content-erasure';
import { QueryNotice } from './query-notice';
import {
 AnnouncementBar, GlobalHeader, RailAccount, RailBottom, RailEmpty, RailGroup, RailHistory, RailNotices, RailOlder, RailStrategyRow, RailView,
 RailWorkThread,
} from './rail-view';
import { useAccountDiscussion } from './use-account-discussion';
import styles from './workspace-frame.module.css';

type Item = {workItemId:string;sessionId:string;title:string;chatName?:string;uiRevision?:number;pinned?:boolean;archived?:boolean;deleted?:boolean;brief:string|null;day:string;revision:number;contentType?:string;lastActivityAt?:string};
type Account = {projectId:string;platform:string;account:string;displayName?:string;uiRevision?:number;strategyDraftId?:string|null;pendingStrategyDraftId?:string|null;sourceVersionId?:string|null;sourceVersion?:number|null;profile?:Record<string,{label?:string;value?:string;status?:string}>|null;items:Item[]};
type Business = {businessId:string;accounts:Account[]};
type Draft = UnassignedDraft&{createdAt?:string;currentVersion?:number};

/** The accepted U0/U1 shell, with real owned OPC projections instead of demo state. */
export function WorkspaceFrame({children,right,rightOpen=true,onToggleRight,activeWorkItemId,area='chat',notice,revealRight}:{
 children:ReactNode;right?:ReactNode;rightOpen?:boolean;onToggleRight?:()=>void;
 /** Changes to a new number when the page wants the right panel shown, also on a phone (where it is an overlay). */
 revealRight?:number;
 activeWorkItemId?:string;area?:'chat'|'library'|'topics'|'marketplace'|'search'|'start';notice?:string;
}){
 const [mobileNav,setMobileNav]=useState(false),[mobileRight,setMobileRight]=useState(false);
 // Reveal before the next animation frame, when the checklist requests field focus.
 useLayoutEffect(()=>{if(revealRight)setMobileRight(true);},[revealRight]);
 const [archiveView,setArchiveView]=useState(false),[menuId,setMenuId]=useState(''),[menuPosition,setMenuPosition]=useState({top:0,left:0});
 const [renameId,setRenameId]=useState(''),[renameValue,setRenameValue]=useState(''),[confirmDelete,setConfirmDelete]=useState(''),[uiError,setUiError]=useState('');
 const [renameAccountId,setRenameAccountId]=useState(''),[renameAccountValue,setRenameAccountValue]=useState('');
 const [expanded,setExpanded]=useState<string[]>([]);
 const [strategyAccount,setStrategyAccount]=useState<Account|null>(null);
 const [noticeOpen,setNoticeOpen]=useState(true);
 const [bottomPanel,setBottomPanel]=useState<'credits'|'profile'|'feedback'|null>(null);
 const [popoverPosition,setPopoverPosition]=useState({left:264,bottom:16,maxHeight:600});
 const [feedbackDraft,setFeedbackDraft]=useState({title:'',description:'',category:'technical_support'});
 const [feedbackError,setFeedbackError]=useState(''),[feedbackSent,setFeedbackSent]=useState(false),[loggingOut,setLoggingOut]=useState(false);
 const [groupOpen,setGroupOpen]=useState<Record<string,boolean>>({});
 const discussion=useAccountDiscussion();
 const router=useRouter();
 const [erasing,setErasing]=useState<{target:ContentErasureTarget;name:string;related?:string[]}|null>(null);
 // Leave a page whose conversation or work was just deleted, here or in another tab.
 const leaveErased=useCallback((target:ContentErasureTarget)=>{
  const session=new URL(location.href).searchParams.get('session');
  const current=target.kind==='session'?session===target.id:target.kind==='artifact'&&activeWorkItemId===target.id;
  if(current)router.replace('/app/positioning');
 },[activeWorkItemId,router]);
 useContentErasureSync(leaveErased);
 const leaveConversation=useCallback((id:string)=>leaveErased({kind:'session',id}),[leaveErased]);
 const conversationErasure=useConversationErasure(leaveConversation);
 const conversationRename=useConversationRename();
 const [deletingConversation,setDeletingConversation]=useState<{id:string;name:string;related?:string[]}|null>(null);
 function startErasure(kind:ContentErasureTarget['kind'],id:string,name:string,related?:string[]){setMenuId('');setErasing({target:{kind,id},name,related});}
 /** The row's "⋯" menu opens below its button, kept inside the window (ChatGPT/Claude style). */
 const menuTrigger=useRef<HTMLElement|null>(null);
 // Esc closes an open row menu and returns focus to its "⋯" button.
 useEffect(()=>{
  if(!menuId)return;
  function onEscape(event:KeyboardEvent){
   if(event.key!=='Escape')return;
   setMenuId('');menuTrigger.current?.focus();
  }
  window.addEventListener('keydown',onEscape);
  return()=>window.removeEventListener('keydown',onEscape);
 },[menuId]);
 function openRowMenu(event:{currentTarget:HTMLElement},id:string){
  menuTrigger.current=event.currentTarget;
  const rect=event.currentTarget.getBoundingClientRect();
  const top=Math.max(8,Math.min(window.innerHeight-236,rect.bottom+4));
  setMenuPosition({top,left:Math.max(8,Math.min(window.innerWidth-186,rect.right-178))});
  setMenuId(current=>current===id?'':id);setConfirmDelete('');
 }
 const pathname=usePathname();
 const [workReturn,setWorkReturn]=useState('');
 useEffect(()=>{
  const current=location.pathname+location.search;
  if(/^\/app\/(runtime|positioning\/[^/?]+)(\/topics)?(?:[?]|$)/.test(current)){
   sessionStorage.setItem('opc-work-return',current);setWorkReturn(current);
  }else setWorkReturn(sessionStorage.getItem('opc-work-return')??'');
 },[pathname,activeWorkItemId]);
 const returnParam=workReturn?'?returnTo='+encodeURIComponent(workReturn):'';
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null});
 const drafts=trpc.opc.list.useQuery();
 const conversations=trpc.opc.conversations.useQuery(undefined,{staleTime:0});
 const visibleConversations=(conversations.data??[]).filter(row=>!conversationErasure.hidden.has(row.sessionId));
 const profile=trpc.user.getUserProfile.useQuery();
 const historyRef=useRef<HTMLDivElement>(null);
 const sidebarActor=profile.data?.id;
 const [restoredActor,setRestoredActor]=useState<string>();
 const pendingScroll=useRef<number|null>(null);
 const restoringScroll=useRef(false);
 const sidebarTouched=useRef(false);
 const previousSidebarActor=useRef<string|undefined>(undefined);
 const sidebarSnapshot=useRef({groupOpen,expanded,archiveView});
 sidebarSnapshot.current={groupOpen,expanded,archiveView};
 const saveSidebar=useCallback(()=>{
  if(!sidebarActor||restoredActor!==sidebarActor)return;
  try{sessionStorage.setItem('opc-sidebar-view:'+sidebarActor,JSON.stringify({...sidebarSnapshot.current,scrollTop:pendingScroll.current??historyRef.current?.scrollTop??0}));}catch{/* View preferences must not block navigation. */}
 },[sidebarActor,restoredActor]);
 function takeSidebarControl(){sidebarTouched.current=true;pendingScroll.current=null;restoringScroll.current=false;}
 useLayoutEffect(()=>{
  if(!sidebarActor)return;
  if(previousSidebarActor.current&&previousSidebarActor.current!==sidebarActor)sidebarTouched.current=false;
  previousSidebarActor.current=sidebarActor;
  let saved:Record<string,unknown>={};
  try{const value=JSON.parse(sessionStorage.getItem('opc-sidebar-view:'+sidebarActor)??'null');if(value&&typeof value==='object')saved=value;}catch{/* Ignore invalid view preferences. */}
  setGroupOpen(saved.groupOpen&&typeof saved.groupOpen==='object'?Object.fromEntries(Object.entries(saved.groupOpen).filter(([,value])=>typeof value==='boolean')):{});
  setExpanded(Array.isArray(saved.expanded)?saved.expanded.filter((value):value is string=>typeof value==='string'):[]);
  setArchiveView(saved.archiveView===true);
  pendingScroll.current=sidebarTouched.current?null:typeof saved.scrollTop==='number'&&Number.isFinite(saved.scrollTop)?Math.max(0,saved.scrollTop):0;
  restoringScroll.current=pendingScroll.current!==null;setRestoredActor(sidebarActor);
 },[sidebarActor]);
 // Wait for every list and the restored expansion state before measuring. A
 // pointer/wheel/key action takes control, so delayed data never moves the user.
 useLayoutEffect(()=>{
  if(!sidebarActor||restoredActor!==sidebarActor||!library.isSuccess||!drafts.isSuccess||!conversations.isSuccess||pendingScroll.current===null)return;
  let frame=0;
  const restore=()=>{const element=historyRef.current;if(!element||pendingScroll.current===null)return;element.scrollTop=pendingScroll.current;};
  restore();
  frame=requestAnimationFrame(()=>{restore();frame=requestAnimationFrame(()=>{if(pendingScroll.current!==null){restore();pendingScroll.current=null;restoringScroll.current=false;saveSidebar();}});});
  return()=>cancelAnimationFrame(frame);
 },[sidebarActor,restoredActor,library.isSuccess,drafts.isSuccess,conversations.isSuccess,library.data,drafts.data,conversations.data,groupOpen,expanded,archiveView,saveSidebar]);
 useEffect(()=>{saveSidebar();},[groupOpen,expanded,archiveView,saveSidebar]);
 const credits=useCreditsBalance();
 const createTicket=trpc.ticket.createTicket.useMutation();
 const changeWorkUi=trpc.opc.workUiChange.useMutation();
 const changeAccountUi=trpc.opc.accountUiChange.useMutation();
 useEffect(()=>{try{const saved=sessionStorage.getItem('opc-feedback-draft');if(saved)setFeedbackDraft(JSON.parse(saved));}catch{/* Keep a fresh local form if an old draft is unreadable. */}},[]);
 useEffect(()=>{if(!bottomPanel)return;function onEscape(event:KeyboardEvent){if(event.key==='Escape')setBottomPanel(null);}window.addEventListener('keydown',onEscape);return()=>window.removeEventListener('keydown',onEscape);},[bottomPanel]);
 function openBottomPanel(panel:'credits'|'profile'|'feedback',element:HTMLElement){
  if(bottomPanel===panel){setBottomPanel(null);return;}
  const box=element.getBoundingClientRect(),width=272;
  setPopoverPosition({left:Math.max(8,Math.min(box.right+8,window.innerWidth-width-8)),bottom:panel==='profile'?20:Math.max(8,window.innerHeight-box.bottom),maxHeight:Math.max(160,box.bottom-16)});
  setBottomPanel(panel);setFeedbackError('');
 }
 function updateFeedback(patch:Partial<typeof feedbackDraft>){setFeedbackDraft(current=>{const next={...current,...patch};sessionStorage.setItem('opc-feedback-draft',JSON.stringify(next));return next;});}
 async function submitFeedback(){if(createTicket.isPending)return;const title=feedbackDraft.title.trim(),description=feedbackDraft.description.trim();if(!title||!description){setFeedbackError('请填写工单标题和问题描述。');return;}setFeedbackError('');try{await createTicket.mutateAsync({title,description,category:feedbackDraft.category,attachments:[]});sessionStorage.removeItem('opc-feedback-draft');setFeedbackDraft({title:'',description:'',category:'technical_support'});setFeedbackSent(true);}catch{setFeedbackError('提交结果未确认，请在“我的工单”核对后再尝试，避免重复提交。');}}
 async function signOut(){if(loggingOut)return;setLoggingOut(true);try{await createClient().auth.signOut();window.location.href=buildAppHref('/');}catch{setLoggingOut(false);}}
 const businesses=(library.data?.businesses??[]) as Business[];
 const platforms=new Map<string,Account[]>();
 for(const business of businesses)for(const account of business.accounts){
  const group=platforms.get(account.platform)??[];group.push(account);platforms.set(account.platform,group);
 }
 const assigned=new Set([...platforms.values()].flat().map(account=>account.strategyDraftId).filter(Boolean));
 const unassigned=((drafts.data?.drafts??[]) as Draft[]).filter(draft=>!assigned.has(draft.draftId));
 // The jury's mark on a draft row; the jury may be off or unreachable, which simply shows no mark.
 const reviews=trpc.fusionReview.mine.useQuery({limit:50},{enabled:unassigned.length>0||assigned.size>0,retry:false,staleTime:30_000});
 const reviewMarks=latestByDraft(Array.isArray(reviews.data)?reviews.data:[]);
 const reviewNote=(draftId:string)=>{const mark=draftMark(reviewMarks.get(draftId))?.label;return mark?' · '+mark:'';};
 async function changeRecord(item:Item,action:'rename'|'pin'|'unpin'|'archive'|'restore'|'delete',name?:string){
  if(changeWorkUi.isPending)return;
  const key='opc-work-ui:'+item.workItemId;
  const raw=sessionStorage.getItem(key);
  const frozen=raw?JSON.parse(raw) as {workItemId:string;requestId:string;expectedRevision:number;action:typeof action;name?:string}:{workItemId:item.workItemId,requestId:crypto.randomUUID(),expectedRevision:item.uiRevision??1,action,...(name?{name}: {})};
  if(raw&&(frozen.action!==action||frozen.name!==name)){setUiError('上次操作的结果待核实，请先恢复同一操作。');return;}
  sessionStorage.setItem(key,JSON.stringify(frozen));setUiError('');
  try{await changeWorkUi.mutateAsync(frozen);sessionStorage.removeItem(key);await library.refetch();setMenuId('');setRenameId('');setConfirmDelete('');}
  catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){sessionStorage.removeItem(key);await library.refetch();setUiError('操作未保存（'+code+'）。列表已刷新，请核对后重试。');}else setUiError('结果暂不确定。原请求已保留；请重试同一操作，避免重复写入。');}
 }
 async function renameAccount(account:Account){
  if(changeAccountUi.isPending)return;
  const name=renameAccountValue.trim(),key='opc-account-ui:'+account.projectId;
  if(!name){setUiError('请输入账号显示名称。');return;}
  const raw=sessionStorage.getItem(key);
  const frozen=raw?JSON.parse(raw) as {accountProjectId:string;requestId:string;expectedRevision:number;name:string}:{accountProjectId:account.projectId,requestId:crypto.randomUUID(),expectedRevision:account.uiRevision??1,name};
  if(raw&&frozen.name!==name){setUiError('上次修改结果待核实，请先恢复原名称。');return;}
  sessionStorage.setItem(key,JSON.stringify(frozen));setUiError('');
  try{await changeAccountUi.mutateAsync(frozen);sessionStorage.removeItem(key);await library.refetch();setRenameAccountId('');}
  catch(cause){const code=cause instanceof Error?cause.message:'';if(['OPC_VERSION_CONFLICT','OPC_REQUEST_CONFLICT','OPC_DENIED','OPC_LIBRARY_INVALID'].includes(code)){sessionStorage.removeItem(key);await library.refetch();setUiError('账号名称未保存（'+code+'）。请核对最新状态。');}else setUiError('账号名称保存结果待核实；原请求已保留，请用同一名称恢复。');}
 }
 function recordMenu(item:Item){
  const name=item.chatName??item.title,open=menuId===item.workItemId;
  return <RailWorkThread key={item.workItemId} sessionId={item.sessionId} name={name} pinned={item.pinned}
   dateLabel={item.lastActivityAt?new Date(item.lastActivityAt).toLocaleDateString('zh-CN'):''} active={activeWorkItemId===item.workItemId}
   renaming={renameId===item.workItemId} renameValue={renameValue} onRenameValue={setRenameValue} onCancelRename={()=>setRenameId('')}
   onSaveRename={()=>void changeRecord(item,'rename',renameValue.trim())} menuOpen={open} menuPosition={menuPosition}
   onOpenMenu={event=>openRowMenu(event,item.workItemId)} archiveView={archiveView} confirming={confirmDelete===item.workItemId}
   onRename={()=>{setRenameId(item.workItemId);setRenameValue(name);setMenuId('');}}
   onPin={()=>void changeRecord(item,item.pinned?'unpin':'pin')} onArchive={()=>void changeRecord(item,'archive')}
   onRestore={()=>void changeRecord(item,'restore')}
   onRemove={()=>{if(confirmDelete===item.workItemId)void changeRecord(item,'delete');else setConfirmDelete(item.workItemId);}}
   onDeleteConversation={()=>{setMenuId('');setDeletingConversation({id:item.sessionId,name:name+' · 对话记录'});}}
   onDeleteArtifact={()=>startErasure('artifact',item.workItemId,item.title+' · 稿件与成果')}/>;
 }

 return <div className={styles.workspace}>
  <GlobalHeader area={area} onOpenNav={()=>setMobileNav(true)}/>
  {noticeOpen&&<AnnouncementBar notice={notice} returnParam={returnParam} onClose={()=>setNoticeOpen(false)}/>}
  <div className={[styles.shell,right&&rightOpen?styles.withRight:'',mobileNav?styles.navOpen:'',mobileRight?styles.mobileRightOpen:'',!noticeOpen?styles.noNotice:''].join(' ')}>
   <RailView area={area} returnParam={returnParam} onCloseMobile={()=>setMobileNav(false)}>
    <RailHistory historyRef={historyRef} archiveView={archiveView} onToggleArchive={()=>setArchiveView(value=>!value)} onControl={takeSidebarControl}
     onScroll={()=>{setMenuId('');if(!restoringScroll.current&&pendingScroll.current===null)saveSidebar();}}>
     {[...platforms].map(([platform,accounts])=>{
      const visible=accounts.map(account=>{
       const showStrategy=Boolean(account.strategyDraftId);
       return {account,showStrategy:archiveView?false:showStrategy,items:account.items.filter(item=>!item.deleted&&Boolean(item.archived)===archiveView)
        .sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))||(b.lastActivityAt??'').localeCompare(a.lastActivityAt??''))};})
       .filter(row=>archiveView?row.items.length:true);
      if(!visible.length)return null;
      return <RailGroup key={platform} title={platform} open={groupOpen['platform:'+platform]??true}
       onToggle={next=>setGroupOpen(current=>current['platform:'+platform]===next?current:{...current,['platform:'+platform]:next})}>
       {visible.map(({account,items,showStrategy})=>{
        const shown=expanded.includes(account.projectId)?items:items.slice(0,6);
        const accountName=account.displayName??account.account,renaming=renameAccountId===account.projectId;
        return <RailAccount key={account.projectId} name={accountName} open={groupOpen['account:'+account.projectId]??true}
         onToggle={next=>setGroupOpen(current=>current['account:'+account.projectId]===next?current:{...current,['account:'+account.projectId]:next})}
         renaming={renaming} renameValue={renameAccountValue} onRenameValue={setRenameAccountValue}
         onStartRename={()=>{setRenameAccountId(account.projectId);setRenameAccountValue(accountName);}}
         onSaveRename={()=>void renameAccount(account)} onCancelRename={()=>setRenameAccountId('')}>
         {showStrategy&&account.strategyDraftId?<RailStrategyRow draftId={account.strategyDraftId} accountName={accountName}
          confirmed={Boolean(account.sourceVersionId)} statusLabel={account.sourceVersion?`当前 v${account.sourceVersion}`:'已确认'}
          reviewNote={reviewNote(account.strategyDraftId)} onOpen={()=>setStrategyAccount(account)}
          menuOpen={menuId==='strategy:'+account.projectId} menuPosition={menuPosition}
          onOpenMenu={event=>{menuTrigger.current=event.currentTarget;const rect=event.currentTarget.getBoundingClientRect();setMenuPosition({top:Math.max(8,Math.min(window.innerHeight-130,rect.bottom+4)),left:Math.max(8,Math.min(window.innerWidth-186,rect.right-178))});setMenuId(current=>current==='strategy:'+account.projectId?'':'strategy:'+account.projectId);}}
          onView={()=>{setMenuId('');setStrategyAccount(account);}} opening={discussion.opening}
          onBackToDiscussion={()=>void discussion.open(account.projectId,()=>setMenuId(''))}/>:!account.strategyDraftId?<RailEmpty>定位策略待建立</RailEmpty>:null}
         {shown.map(recordMenu)}
         {shown.length<items.length&&<RailOlder count={items.length-shown.length} onClick={()=>setExpanded(current=>[...current,account.projectId])}/>}
        </RailAccount>;
       })}
      </RailGroup>;
     })}
     {!archiveView&&<QueryNotice error={conversations.error} loading={conversations.isPending} label="对话记录" retry={()=>conversations.refetch()}/>}
     {!archiveView&&visibleConversations.length>0&&<RailGroup title="对话" open={groupOpen.conversations??true} onToggle={next=>setGroupOpen(current=>current.conversations===next?current:{...current,conversations:next})}>{visibleConversations.map(conversation=><ConversationRow key={conversation.sessionId}
      conversation={conversation} menuOpen={menuId==='conversation:'+conversation.sessionId} menuPosition={menuPosition}
      onOpenMenu={event=>openRowMenu(event,'conversation:'+conversation.sessionId)} onCloseMenu={()=>setMenuId('')}
      onDelete={()=>setDeletingConversation({id:conversation.sessionId,
       name:conversationRename.titleOf(conversation.sessionId,conversation.title)})} rename={conversationRename}/>)}</RailGroup>}
     {!archiveView&&unassigned.length>0&&<RailGroup title="待归类" open={groupOpen.unassigned??true} onToggle={next=>setGroupOpen(current=>current.unassigned===next?current:{...current,unassigned:next})}>{unassigned.map(draft=><DraftRow key={draft.draftId} draft={draft} review={draftMark(reviewMarks.get(draft.draftId))?.label}
      menuOpen={menuId==='draft:'+draft.draftId} menuPosition={menuPosition} onCloseMenu={()=>setMenuId('')}
      onOpenMenu={event=>openRowMenu(event,'draft:'+draft.draftId)}
      onDeleteConversation={(id,name)=>setDeletingConversation({id,name,related:[draft.draftId]})}
      onDeleteDraft={(id,name)=>startErasure('artifact',id,name+' · 稿件与成果',[draft.draftId,...(draft.topicSessionId?[draft.topicSessionId]:[])])}/>)}</RailGroup>}
     <QueryNotice error={library.error||drafts.error} loading={library.isPending||drafts.isPending} label="账号与资料" retry={()=>Promise.all([library.refetch(),drafts.refetch()])}/>
     {library.isSuccess&&drafts.isSuccess&&!library.error&&!drafts.error&&(!archiveView&&!platforms.size&&!unassigned.length||archiveView&&![...platforms.values()].flat().some(account=>account.items.some(item=>item.archived&&!item.deleted)))&&<p className={styles.empty}>{archiveView?'暂无归档记录。':'完成定位并采用选题后，账号工作会出现在这里。'}</p>}
    </RailHistory>
    <RailNotices items={[discussion.error&&{text:discussion.error,role:'alert' as const},uiError&&{text:uiError,role:'alert' as const},
     conversationRename.error&&{text:conversationRename.error,role:'alert' as const},
     conversationErasure.notice&&{text:conversationErasure.notice.text,role:conversationErasure.notice.tone==='error'?'alert' as const:'status' as const}].filter(Boolean) as Array<{text:string;role:'alert'|'status'}>}/>
    <RailBottom creditsLabel={credits.status==='ready'?credits.credits:'查看'} creditsOpen={bottomPanel==='credits'} profileOpen={bottomPanel==='profile'}
     avatar={(profile.data?.nickname??profile.data?.email??'我').slice(0,1)} name={profile.data?.nickname??profile.data?.email??'个人中心'}
     membership={membershipText(profile,'普通会员','查看账户')}
     onFeedback={event=>{setFeedbackSent(false);openBottomPanel('feedback',event.currentTarget);}} onCredits={event=>openBottomPanel('credits',event.currentTarget)}
     onProfile={event=>openBottomPanel('profile',event.currentTarget)}/>
   </RailView>
   <section className={styles.center}>
   {right&&<button type="button" className={styles.mobileRightToggle} aria-label="展开右边栏" onClick={()=>{if(!rightOpen)onToggleRight?.();setMobileRight(true);}}><PanelRightClose size={18}/></button>}
   <div className={styles.mobileBar}><button aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={19}/></button><span>Graylum · 工作区</span>{right&&<button onClick={()=>{if(!rightOpen)onToggleRight?.();setMobileRight(true);}} aria-label="打开成果"><BookOpen size={18}/></button>}</div>
    {children}
   </section>
   {right&&rightOpen&&<aside className={styles.right} aria-label="当前成果"><div className={styles.rightToggle}><button aria-label="收起成果面板" onClick={()=>{if(window.matchMedia('(max-width:700px)').matches)setMobileRight(false);else onToggleRight?.();}}><PanelRightClose size={18}/></button></div>{right}</aside>}
  </div>
  {(bottomPanel==='credits'||bottomPanel==='profile')&&<><button type="button" className={styles.popoverDismiss} aria-label="关闭侧栏弹出层" onClick={()=>setBottomPanel(null)}/><section role="dialog" aria-label={bottomPanel==='credits'?'积分详情':'个人资料与账户'} className={styles.bottomPopover} style={{left:popoverPosition.left,bottom:popoverPosition.bottom,maxHeight:popoverPosition.maxHeight}}>{bottomPanel==='credits'?<><div className={styles.creditSummary}><span className={styles.planBadge}><Sparkles size={14} aria-hidden="true"/>{membershipText(profile,'基础套餐','会员账户')}</span><div className={styles.creditBalance}><div><p>剩余积分</p><strong>{credits.status==='ready'?credits.credits:credits.status==='loading'?'读取中':'暂不可用'}{credits.status==='ready'&&<span className={styles.creditUnit}>积分</span>}</strong></div><span className={styles.balanceIcon} aria-hidden="true"><img src="/opc-reference/wallet-color.svg" alt=""/></span></div><small>积分明细与套餐信息可在账户查看。</small></div><div className={styles.popoverFoot}><p>需要更多积分？</p><Link href="/app/profile?tab=subscription" onClick={()=>setBottomPanel(null)}>查看套餐 →</Link></div></>:<><div className={styles.profileHead}><span className={styles.avatar}>{(profile.data?.nickname??profile.data?.email??'我').slice(0,1)}</span><span><strong>{profile.data?.nickname??profile.data?.email??'个人中心'}</strong><small>{profile.data?.email??''}</small></span></div><div className={styles.membership}><Link href="/app/profile" onClick={()=>setBottomPanel(null)}><span>{membershipText(profile)}</span><span className={styles.membershipLink}><span>账户与积分</span><span aria-hidden="true">→</span></span></Link></div><Link href="/app/profile" onClick={()=>setBottomPanel(null)}><UserRound size={17}/>个人中心</Link><Link href="/" onClick={()=>setBottomPanel(null)}><Grid2X2 size={17}/>返回首页</Link><button type="button" disabled={loggingOut} onClick={signOut}><LogOut size={17}/>{loggingOut?'退出中…':'退出登录'}</button></>}</section></>}
  {bottomPanel==='feedback'&&<div className={styles.feedbackBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget&&!createTicket.isPending)setBottomPanel(null);}}><section role="dialog" aria-modal="true" aria-label="在线反馈" className={styles.feedbackDialog}><header><h2>在线反馈</h2><button type="button" aria-label="关闭在线反馈" onClick={()=>setBottomPanel(null)}><X size={18}/></button></header>{feedbackSent?<div className={styles.feedbackBody}><p role="status">反馈已提交。你可以在我的工单查看后续进度。</p><Link href="/app/profile?tab=tickets">查看我的工单 →</Link></div>:<div className={styles.feedbackBody}><p>提交问题或建议，后续可在我的工单查看。</p><label>问题类型<select aria-label="问题类型" value={feedbackDraft.category} onChange={event=>updateFeedback({category:event.target.value})}><option value="technical_support">技术支持</option><option value="feature_request">功能建议</option><option value="bug_report">Bug 反馈</option><option value="account_issue">账户问题</option><option value="other">其他</option></select></label><label>工单标题<input aria-label="工单标题" maxLength={80} value={feedbackDraft.title} onChange={event=>updateFeedback({title:event.target.value})}/></label><label>问题描述<textarea aria-label="问题描述" maxLength={2000} value={feedbackDraft.description} onChange={event=>updateFeedback({description:event.target.value})}/></label>{feedbackError&&<p role="alert" className={styles.feedbackError}>{feedbackError}</p>}<footer><Link href="/app/profile?tab=tickets">我的工单</Link><button type="button" disabled={createTicket.isPending} onClick={submitFeedback}>{createTicket.isPending?'提交中…':'提交反馈'}</button></footer></div>}</section></div>}
  {strategyAccount?.strategyDraftId&&strategyAccount.sourceVersionId&&<StrategyOverviewDialog account={{projectId:strategyAccount.projectId,platform:strategyAccount.platform,account:strategyAccount.displayName??strategyAccount.account,strategyDraftId:strategyAccount.strategyDraftId,pendingStrategyDraftId:strategyAccount.pendingStrategyDraftId,sourceVersionId:strategyAccount.sourceVersionId,currentVersion:strategyAccount.sourceVersion??undefined,profile:strategyAccount.profile}} onSaved={async()=>{const fresh=await library.refetch();const updated=((fresh.data?.businesses??[]) as Business[]).flatMap(business=>business.accounts).find(account=>account.projectId===strategyAccount.projectId);if(updated)setStrategyAccount(updated);}} onClose={()=>setStrategyAccount(null)}/>}
 {deletingConversation&&<ConversationDeleteDialog name={deletingConversation.name}
  onCancel={()=>setDeletingConversation(null)}
  onConfirm={()=>{const {id,related}=deletingConversation;setDeletingConversation(null);void conversationErasure.erase(id,related);}}/>}
 {erasing&&<ContentErasureDialog target={erasing.target} name={erasing.name} relatedIds={erasing.related}
  onClose={finished=>{const target=erasing.target;setErasing(null);if(finished)leaveErased(target);}}/>}
 </div>;
}
