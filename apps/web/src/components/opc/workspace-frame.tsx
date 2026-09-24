'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, BookOpen, CalendarDays, ChartNoAxesColumnIncreasing, ChevronDown, Ellipsis, Grid2X2, LogOut, Menu, PanelRightClose, Pencil, Pin, Search, Sparkles, Ticket, UserRound, Wallet, X } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { useCreditsBalance } from '@/hooks/use-credits';
import { createClient } from '@/lib/supabase';
import { buildAppHref } from '@/lib/site-config';
import styles from './workspace-frame.module.css';

type Item = {workItemId:string;sessionId:string;title:string;chatName?:string;uiRevision?:number;pinned?:boolean;archived?:boolean;deleted?:boolean;brief:string|null;day:string;revision:number;contentType?:string;lastActivityAt?:string};
type Account = {projectId:string;platform:string;account:string;displayName?:string;uiRevision?:number;strategyDraftId?:string|null;items:Item[]};
type Business = {businessId:string;accounts:Account[]};
type Draft = {draftId:string;businessName?:string;createdAt?:string;currentVersion?:number;state?:string};

/** The accepted U0/U1 shell, with real owned OPC projections instead of demo state. */
export function WorkspaceFrame({children,right,rightOpen=true,onToggleRight,activeWorkItemId,area='chat',notice}:{
 children:ReactNode;right?:ReactNode;rightOpen?:boolean;onToggleRight?:()=>void;
 activeWorkItemId?:string;area?:'chat'|'library'|'topics'|'marketplace'|'start';notice?:string;
}){
 const [mobileNav,setMobileNav]=useState(false),[mobileRight,setMobileRight]=useState(false),[query,setQuery]=useState('');
 const [archiveView,setArchiveView]=useState(false),[menuId,setMenuId]=useState(''),[menuPosition,setMenuPosition]=useState({top:0,left:0});
 const [renameId,setRenameId]=useState(''),[renameValue,setRenameValue]=useState(''),[confirmDelete,setConfirmDelete]=useState(''),[uiError,setUiError]=useState('');
 const [renameAccountId,setRenameAccountId]=useState(''),[renameAccountValue,setRenameAccountValue]=useState('');
 const [expanded,setExpanded]=useState<string[]>([]);
 const [noticeOpen,setNoticeOpen]=useState(true);
 const [bottomPanel,setBottomPanel]=useState<'credits'|'profile'|'feedback'|null>(null);
 const [popoverPosition,setPopoverPosition]=useState({left:264,bottom:16,maxHeight:600});
 const [feedbackDraft,setFeedbackDraft]=useState({title:'',description:'',category:'technical_support'});
 const [feedbackError,setFeedbackError]=useState(''),[feedbackSent,setFeedbackSent]=useState(false),[loggingOut,setLoggingOut]=useState(false);
 const [groupOpen,setGroupOpen]=useState<Record<string,boolean>>({});
 const searchRef=useRef<HTMLInputElement>(null);
 const pathname=usePathname();
 const [workReturn,setWorkReturn]=useState('');
 useEffect(()=>{
  const current=location.pathname+location.search;
  if(/^\/(runtime|positioning\/[^/?]+)(\/topics)?(?:[?]|$)/.test(current)){
   sessionStorage.setItem('opc-work-return',current);setWorkReturn(current);
  }else setWorkReturn(sessionStorage.getItem('opc-work-return')??'');
 },[pathname,activeWorkItemId]);
 const returnParam=workReturn?'?returnTo='+encodeURIComponent(workReturn):'';
 const library=trpc.opc.library.useQuery({search:'',from:null,to:null});
 const drafts=trpc.opc.list.useQuery();
 const profile=trpc.user.getUserProfile.useQuery();
 const credits=useCreditsBalance();
 const creditsSummary=trpc.credits.getCreditsSummary.useQuery({period:'month'},{enabled:bottomPanel==='credits'});
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
 async function signOut(){if(loggingOut)return;setLoggingOut(true);try{await createClient().auth.signOut();window.location.href=buildAppHref('/landing');}catch{setLoggingOut(false);}}
 const businesses=(library.data?.businesses??[]) as Business[];
 const platforms=new Map<string,Account[]>();
 for(const business of businesses)for(const account of business.accounts){
  const group=platforms.get(account.platform)??[];group.push(account);platforms.set(account.platform,group);
 }
 const assigned=new Set([...platforms.values()].flat().map(account=>account.strategyDraftId).filter(Boolean));
 const unassigned=((drafts.data?.drafts??[]) as Draft[]).filter(draft=>!assigned.has(draft.draftId)&&(!query||(`${draft.businessName??''} 定位`).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
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
 function recordMenu(item:Item){return <div className={styles.threadRow} key={item.workItemId}>
  {renameId===item.workItemId?<input className={styles.inlineRename} autoFocus aria-label="重命名对话" maxLength={160} value={renameValue} onChange={event=>setRenameValue(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')setRenameId('');if(event.key==='Enter'&&renameValue.trim())void changeRecord(item,'rename',renameValue.trim());}}/>:<Link className={styles.thread} aria-current={activeWorkItemId===item.workItemId?'page':undefined} href={'/runtime?session='+item.sessionId}><span>{item.pinned&&<Pin size={12} aria-label="已置顶"/>}{item.chatName??item.title}</span><small>{item.lastActivityAt?new Date(item.lastActivityAt).toLocaleDateString('zh-CN'):''} · 工作对话</small></Link>}
  <button className={styles.more} aria-label={(item.chatName??item.title)+'的更多操作'} aria-expanded={menuId===item.workItemId} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenuPosition({top:Math.max(8,Math.min(window.innerHeight-166,rect.bottom+4)),left:Math.max(8,Math.min(window.innerWidth-186,rect.right-178))});setMenuId(current=>current===item.workItemId?'':item.workItemId);setConfirmDelete('');}}><Ellipsis size={17}/></button>
  {menuId===item.workItemId&&<div className={styles.workMenu} style={menuPosition} role="menu"><button role="menuitem" onClick={()=>{setRenameId(item.workItemId);setRenameValue(item.chatName??item.title);setMenuId('');}}>重命名</button>{archiveView?<button role="menuitem" onClick={()=>void changeRecord(item,'restore')}>恢复归档</button>:<><button role="menuitem" onClick={()=>void changeRecord(item,item.pinned?'unpin':'pin')}>{item.pinned?'取消置顶':'置顶'}</button><button role="menuitem" onClick={()=>void changeRecord(item,'archive')}>归档</button></>}<button role="menuitem" className={styles.danger} onClick={()=>{if(confirmDelete===item.workItemId)void changeRecord(item,'delete');else setConfirmDelete(item.workItemId);}}>{confirmDelete===item.workItemId?'确认删除此聊天记录':'删除'}</button></div>}
 </div>}

 return <div className={styles.workspace}>
  <header className={styles.global}>
   <Link href="/" className={styles.brand}><img src="/graylum-logo.png" alt="" />Graylum</Link>
   <button type="button" className={styles.mobileGlobalMenu} aria-label="打开导航" onClick={()=>setMobileNav(true)}><Grid2X2 size={17}/></button>
   <nav aria-label="全局导航"><Link href="/">首页</Link><Link href="/positioning" aria-current={area==='chat'||area==='topics'||area==='start'?'page':undefined}>对话</Link><Link href="/profile">个人中心</Link></nav>
  </header>
  {noticeOpen&&<div className={styles.announcement}>{notice&&<span>{notice}</span>}<Sparkles size={15}/><strong>让好想法，继续向前。</strong><Link href={'/workbench/marketplace'+returnParam}>探索创作功能</Link><button aria-label="关闭公告" onClick={()=>setNoticeOpen(false)}><X size={15}/></button></div>}
  <div className={[styles.shell,right&&rightOpen?styles.withRight:'',mobileNav?styles.navOpen:'',mobileRight?styles.mobileRightOpen:'',!noticeOpen?styles.noNotice:''].join(' ')}>
   <aside className={styles.rail} aria-label="工作区导航">
    <div className={styles.railMobile}><strong>工作区</strong><button aria-label="关闭导航" onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
    <Link className={styles.newConversation} href="/positioning"><span className={styles.newConversationIcon} aria-hidden="true">＋</span>新对话</Link>
    <nav className={styles.railNav} aria-label="工作区功能">
     <Link href={'/workbench/marketplace'+returnParam} aria-current={area==='marketplace'?'page':undefined}><Grid2X2 size={17}/>功能广场</Link>
     <button onClick={()=>{setArchiveView(false);searchRef.current?.focus()}}><Search size={17}/>搜索</button>
     <Link href={'/library'+returnParam} aria-current={area==='library'?'page':undefined}><BookOpen size={17}/>资料库</Link>
     <button disabled><CalendarDays size={17}/>发布排期 <small>待接入</small></button>
     <button disabled><ChartNoAxesColumnIncreasing size={17}/>数据复盘 <small>待接入</small></button>
    </nav>
    <div className={styles.history} aria-label="平台、账号与工作" onScroll={()=>setMenuId('')}>
    <div className={styles.historyHead}><span>{archiveView?'归档记录':'平台 · 账号 · 工作'}</span><button onClick={()=>setArchiveView(value=>!value)}>{archiveView?'返回最近工作':'查看归档'}</button></div>
    <label className={styles.searchLabel} htmlFor="workspace-work-search">查找账号或工作</label>
    <label className={styles.search}><Search size={14}/><input id="workspace-work-search" ref={searchRef} aria-label="查找账号或工作" placeholder="搜索账号、工作" value={query} onChange={event=>setQuery(event.target.value)}/></label>
     {[...platforms].map(([platform,accounts])=>{
      const needle=query.trim().toLocaleLowerCase();
      const visible=accounts.map(account=>{
       const scopeMatch=(account.account+' '+(account.displayName??'')+' '+platform).toLocaleLowerCase().includes(needle);
       const showStrategy=Boolean(account.strategyDraftId)&&(!needle||scopeMatch||'定位策略'.includes(needle));
       return {account,showStrategy:archiveView?false:showStrategy,items:account.items.filter(item=>!item.deleted&&Boolean(item.archived)===archiveView&&(scopeMatch||(item.chatName??item.title).toLocaleLowerCase().includes(needle)))
        .sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))||(b.lastActivityAt??'').localeCompare(a.lastActivityAt??''))};})
       .filter(row=>archiveView?row.items.length:!needle||row.items.length||row.showStrategy||(row.account.displayName??row.account.account).toLocaleLowerCase().includes(needle));
      if(!visible.length)return null;
      return <details key={platform} open={groupOpen['platform:'+platform]??true} onToggle={event=>{const next=event.currentTarget.open;setGroupOpen(current=>current['platform:'+platform]===next?current:{...current,['platform:'+platform]:next});}}>
       <summary>{platform}<ChevronDown size={14}/></summary>
       {visible.map(({account,items,showStrategy})=>{
        const shown=query||expanded.includes(account.projectId)?items:items.slice(0,6);
        const strategy=((drafts.data?.drafts??[]) as Draft[]).find(draft=>draft.draftId===account.strategyDraftId);
        return <details key={account.projectId} open={groupOpen['account:'+account.projectId]??true} onToggle={event=>{const next=event.currentTarget.open;setGroupOpen(current=>current['account:'+account.projectId]===next?current:{...current,['account:'+account.projectId]:next});}} className={styles.account}>
         <summary>{renameAccountId===account.projectId?<input className={styles.accountRename} aria-label="重命名账号" maxLength={120} autoFocus value={renameAccountValue} onClick={event=>event.stopPropagation()} onChange={event=>setRenameAccountValue(event.target.value)} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')setRenameAccountId('');if(event.key==='Enter')void renameAccount(account);}}/>:<span>{account.displayName??account.account}</span>}<button type="button" aria-label={renameAccountId===account.projectId?'保存账号名称':'重命名账号 '+(account.displayName??account.account)} onClick={event=>{event.preventDefault();event.stopPropagation();if(renameAccountId===account.projectId)void renameAccount(account);else{setRenameAccountId(account.projectId);setRenameAccountValue(account.displayName??account.account);}}}>{renameAccountId===account.projectId?'✓':<Pencil size={14}/>}</button><ChevronDown size={13}/></summary>
         {showStrategy&&account.strategyDraftId?<Link className={styles.strategy} href={'/positioning/'+account.strategyDraftId}><span><Pin size={12}/>定位策略</span><small>{strategy?.currentVersion?`当前 v${strategy.currentVersion}`:'进行中'} · {account.displayName??account.account}</small></Link>:!needle&&!account.strategyDraftId?<p className={styles.empty}>定位策略待建立</p>:null}
         {shown.map(recordMenu)}
         {shown.length<items.length&&<button className={styles.older} onClick={()=>setExpanded(current=>[...current,account.projectId])}>查看更早 {items.length-shown.length} 项</button>}
        </details>;
       })}
      </details>;
     })}
     {!archiveView&&unassigned.length>0&&<details open={groupOpen.unassigned??true} onToggle={event=>{const next=event.currentTarget.open;setGroupOpen(current=>current.unassigned===next?current:{...current,unassigned:next});}}><summary>待归类<ChevronDown size={14}/></summary>{unassigned.map(draft=><Link key={draft.draftId} className={styles.thread} href={'/positioning/'+draft.draftId}><span>{draft.businessName??'新账号'} · 定位分析</span><small>{draft.state==='published'?'已确认':'进行中'}</small></Link>)}</details>}
     {!library.isLoading&&(!archiveView&&!platforms.size&&!unassigned.length||archiveView&&![...platforms.values()].flat().some(account=>account.items.some(item=>item.archived&&!item.deleted)))&&<p className={styles.empty}>{archiveView?'暂无归档记录。':'完成定位并采用选题后，账号工作会出现在这里。'}</p>}
    </div>
    {uiError&&<p role="alert" className={styles.uiError}>{uiError}</p>}<div className={styles.railBottom}><div className={styles.creditWidget}><button type="button" onClick={event=>{setFeedbackSent(false);openBottomPanel('feedback',event.currentTarget);}}><Ticket size={19}/>在线反馈<ArrowUpRight size={14} className={styles.externalIcon}/></button><button type="button" aria-expanded={bottomPanel==='credits'} onClick={event=>openBottomPanel('credits',event.currentTarget)}><Wallet size={19}/>积分 <small>{credits.status==='ready'?credits.credits:'查看'}</small></button></div><button type="button" className={styles.profile} aria-expanded={bottomPanel==='profile'} onClick={event=>openBottomPanel('profile',event.currentTarget)}><span className={styles.avatar}>{(profile.data?.nickname??profile.data?.email??'我').slice(0,1)}</span><span>{profile.data?.nickname??profile.data?.email??'个人中心'}<small>{profile.data?.membership_level==='free'?'普通会员':'查看账户'}</small></span><ChevronDown size={14}/></button></div>
   </aside>
   <section className={styles.center}>
   {right&&<button type="button" className={styles.mobileRightToggle} aria-label="展开右边栏" onClick={()=>{if(!rightOpen)onToggleRight?.();setMobileRight(true);}}><PanelRightClose size={18}/></button>}
   <div className={styles.mobileBar}><button aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={19}/></button><span>Graylum · 工作区</span>{right&&<button onClick={()=>{if(!rightOpen)onToggleRight?.();setMobileRight(true);}} aria-label="打开成果"><BookOpen size={18}/></button>}</div>
    {children}
   </section>
   {right&&rightOpen&&<aside className={styles.right} aria-label="当前成果"><div className={styles.rightToggle}><button aria-label="收起成果面板" onClick={()=>{if(window.matchMedia('(max-width:700px)').matches)setMobileRight(false);else onToggleRight?.();}}><PanelRightClose size={18}/></button></div>{right}</aside>}
  </div>
  {(bottomPanel==='credits'||bottomPanel==='profile')&&<><button type="button" className={styles.popoverDismiss} aria-label="关闭侧栏弹出层" onClick={()=>setBottomPanel(null)}/><section role="dialog" aria-label={bottomPanel==='credits'?'积分详情':'个人资料与账户'} className={styles.bottomPopover} style={{left:popoverPosition.left,bottom:popoverPosition.bottom,maxHeight:popoverPosition.maxHeight}}>{bottomPanel==='credits'?<><div className={styles.creditSummary}><span className={styles.planBadge}>✦　{profile.data?.membership_level==='free'?'基础套餐':'会员账户'}</span><p>剩余积分 <small>实际余额</small></p><strong>{credits.status==='ready'?credits.credits:credits.status==='loading'?'读取中':'暂不可用'}</strong><div className={styles.creditTrack} aria-hidden="true"><span/></div><div className={styles.creditUsage}>本期已用 {creditsSummary.data?.totalSpent??(creditsSummary.isLoading?'读取中':'暂不可用')}</div><small>积分以当前账户为准；套餐额度与续期信息请在账户中查看。</small></div><div className={styles.popoverFoot}><p>需要更多积分？</p><Link href="/profile?tab=subscription" onClick={()=>setBottomPanel(null)}>查看套餐 →</Link></div></>:<><div className={styles.profileHead}><span className={styles.avatar}>{(profile.data?.nickname??profile.data?.email??'我').slice(0,1)}</span><span><strong>{profile.data?.nickname??profile.data?.email??'个人中心'}</strong><small>{profile.data?.email??''}</small></span></div><div className={styles.membership}><span>{profile.data?.membership_level==='free'?'普通会员':'会员账户'}</span><button onClick={()=>setBottomPanel('credits')}>账户与积分 →</button></div><Link href="/profile" onClick={()=>setBottomPanel(null)}><UserRound size={17}/>个人中心</Link><Link href="/" onClick={()=>setBottomPanel(null)}><Grid2X2 size={17}/>返回首页</Link><button type="button" disabled={loggingOut} onClick={signOut}><LogOut size={17}/>{loggingOut?'退出中…':'退出登录'}</button></>}</section></>}
  {bottomPanel==='feedback'&&<div className={styles.feedbackBackdrop} onMouseDown={event=>{if(event.target===event.currentTarget&&!createTicket.isPending)setBottomPanel(null);}}><section role="dialog" aria-modal="true" aria-label="在线反馈" className={styles.feedbackDialog}><header><h2>在线反馈</h2><button type="button" aria-label="关闭在线反馈" onClick={()=>setBottomPanel(null)}><X size={18}/></button></header>{feedbackSent?<div className={styles.feedbackBody}><p role="status">反馈已提交。你可以在我的工单查看后续进度。</p><Link href="/profile?tab=tickets">查看我的工单 →</Link></div>:<div className={styles.feedbackBody}><p>提交问题或建议，后续可在我的工单查看。</p><label>问题类型<select aria-label="问题类型" value={feedbackDraft.category} onChange={event=>updateFeedback({category:event.target.value})}><option value="technical_support">技术支持</option><option value="feature_request">功能建议</option><option value="bug_report">Bug 反馈</option><option value="account_issue">账户问题</option><option value="other">其他</option></select></label><label>工单标题<input aria-label="工单标题" maxLength={80} value={feedbackDraft.title} onChange={event=>updateFeedback({title:event.target.value})}/></label><label>问题描述<textarea aria-label="问题描述" maxLength={2000} value={feedbackDraft.description} onChange={event=>updateFeedback({description:event.target.value})}/></label>{feedbackError&&<p role="alert" className={styles.feedbackError}>{feedbackError}</p>}<footer><Link href="/profile?tab=tickets">我的工单</Link><button type="button" disabled={createTicket.isPending} onClick={submitFeedback}>{createTicket.isPending?'提交中…':'提交反馈'}</button></footer></div>}</section></div>}
 </div>;
}
