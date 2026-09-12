/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import {useEffect,useRef,useState} from 'react';
import type {inferRouterOutputs} from '@trpc/server';
import type {AppRouter} from '@repo/api/src/root';
import {trpc} from '@/trpc/client';
import {AppHeader} from '@/components/layout/AppHeader';
import {ChatSidebar} from '@/components/chat/ChatSidebar';
import {SliceArtifact,type SliceTarget,type SliceDrafts} from './agent-slice-artifact';
import {SliceStartWork} from './agent-slice-start-work';
import {SlicePreferences} from './agent-slice-preferences';
import {Button} from '@/components/ui/button';
type Page=inferRouterOutputs<AppRouter>['agentSlice']['conversation'];
type Turn=Page['items'][number];
async function deadline<T>(promise:Promise<T>,ms=10000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('连接暂时没有响应，请重试。')),ms);})]).finally(()=>clearTimeout(timer));}
/** Same official chat route and shared application shell. No duplicate body store. */
export function AgentSliceConversation({conversationId,navigate}:{conversationId:string;navigate:(id?:string)=>void}){
 const api=trpc.useUtils().client.agentSlice;
 const identity=trpc.user.getUserProfile.useQuery(undefined,{retry:false});
 const targets=trpc.agentSlice.targets.useQuery(undefined,{retry:false,refetchOnWindowFocus:true});
 const [page,setPage]=useState<Page|null>(null),[input,setInput]=useState(''),[error,setError]=useState('');
 const [artifactDrafts,setArtifactDrafts]=useState<SliceDrafts>({});
 const [local,setLocal]=useState<Turn|null>(null),[activity,setActivity]=useState<{id:string;text:string}|null>(null);
 const [heldTarget,setHeldTarget]=useState<Pick<SliceTarget,'projectId'|'roundId'|'stepId'|'pairId'>|null>(null),[showArtifact,setShowArtifact]=useState(false);const epoch=useRef(0),locked=useRef(false),scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
 const load=async()=>{const value=await deadline(api.conversation.query({conversationId}));setPage(value);return value;};
 useEffect(()=>{let alive=true;const refresh=()=>{void deadline(api.conversation.query({conversationId})).then(value=>{if(alive){setPage(value);setError('');}}).catch(()=>{if(alive){setPage(null);setError('暂时无法读取对话，请重试。');}});};refresh();const visible=()=>{if(document.visibilityState==='visible')refresh();};window.addEventListener('online',refresh);document.addEventListener('visibilitychange',visible);return()=>{alive=false;epoch.current++;window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',visible);};},[api,conversationId]);
 // Financial maintenance is separate from the pure history query and never
 // blocks rendering saved text. Refresh/online repeats only unfinished work.
 const settling=useRef(new Set<string>()),settled=useRef(new Set<string>());
 useEffect(()=>{for(const turn of page?.items??[]){const id=turn.executionId;
  if(settling.current.has(id)||settled.current.has(id))continue;settling.current.add(id);
  void deadline(api.recover.mutate({executionId:id}),35000).then(value=>{
   if(value.calls.length===3&&value.calls.every(call=>call.state==='settled'||call.state==='refunded'))settled.current.add(id);
  }).catch(()=>{/* Retry on the next authoritative refresh; never regenerate. */}).finally(()=>settling.current.delete(id));
 }},[api,page]);
 const rows=[...(page?.items??[])];if(local&&!rows.some(r=>r.executionId===local.executionId))rows.unshift(local);
 // Server supplies descending tuple order; preserve it rather than reparsing timestamps.
 const turns=rows.slice().reverse();
 const choices=(targets.data??[]).flatMap(work=>work.steps.map(step=>({...work,stepId:step.id,stepTitle:step.title})));
 // A tab-local hint identifies a choice; only fresh server choices authorize it.
 const selectionKey=identity.data?.id?`graylum:slice-selection:1:${identity.data.id}:${conversationId}`:null;
 const restoredKey=useRef<string|null>(null),selectionEpoch=useRef(0);
 const [selectionReady,setSelectionReady]=useState(false);
 useEffect(()=>{
  if(!selectionKey||restoredKey.current===selectionKey)return;
  selectionEpoch.current++;restoredKey.current=selectionKey;setHeldTarget(null);
  try{const value=JSON.parse(sessionStorage.getItem(selectionKey)??'null');
   if(value&&['projectId','roundId','stepId','pairId'].every(k=>typeof value[k]==='string'&&value[k].length>0&&value[k].length<=100))
    setHeldTarget({projectId:value.projectId,roundId:value.roundId,stepId:value.stepId,pairId:value.pairId});
  }catch{/* Unavailable or corrupt storage requires an explicit choice. */}
  setSelectionReady(true);
 },[selectionKey]);
 const choose=(value:typeof heldTarget)=>{
  selectionEpoch.current++;setCheckRevision(v=>v+1);setHeldTarget(value?{projectId:value.projectId,roundId:value.roundId,stepId:value.stepId,pairId:value.pairId}:null);
  if(selectionKey)try{if(value)sessionStorage.setItem(selectionKey,JSON.stringify({projectId:value.projectId,roundId:value.roundId,stepId:value.stepId,pairId:value.pairId}));else sessionStorage.removeItem(selectionKey);}catch{/* The current explicit choice remains usable; refresh will require selection. */}
 };
 const target=choices.find(r=>r.projectId===heldTarget?.projectId&&r.roundId===heldTarget.roundId&&r.stepId===heldTarget.stepId&&r.pairId===heldTarget.pairId);
 const selectionId=heldTarget?selectionKey+':'+JSON.stringify(heldTarget):'';
 const [checkRevision,setCheckRevision]=useState(0);
 const [checked,setChecked]=useState<{id:string;revision:number;executable:boolean;error:boolean}|null>(null);
 useEffect(()=>{
  if(!heldTarget||!selectionReady||restoredKey.current!==selectionKey)return;
  let alive=true;
  void deadline(api.target.query(heldTarget)).then(value=>{if(alive)setChecked({id:selectionId,revision:checkRevision,executable:value.executable,error:false});}).catch(()=>{if(alive)setChecked({id:selectionId,revision:checkRevision,executable:false,error:true});});
  return()=>{alive=false;};
 },[api,heldTarget,selectionReady,selectionKey,selectionId,checkRevision]);
 const recheck=()=>setCheckRevision(v=>v+1);
 useEffect(()=>{
  const visible=()=>{if(document.visibilityState==='visible')setCheckRevision(v=>v+1);};
  window.addEventListener('online',visible);window.addEventListener('pageshow',visible);document.addEventListener('visibilitychange',visible);
  return()=>{window.removeEventListener('online',visible);window.removeEventListener('pageshow',visible);document.removeEventListener('visibilitychange',visible);};
 },[]);
 const selectedCheck={data:checked?.id===selectionId&&checked.revision===checkRevision?checked:null,isFetching:!!heldTarget&&(checked?.id!==selectionId||checked.revision!==checkRevision),error:checked?.id===selectionId&&checked.revision===checkRevision&&checked.error,refetch:recheck};

 const canSend=!!selectedCheck.data?.executable&&!selectedCheck.isFetching&&!selectedCheck.error&&restoredKey.current===selectionKey&&selectionReady&&!!selectionKey&&!identity.error&&!targets.isFetching&&!targets.error&&target?.state==='draft';
 const renderedSelectionEpoch=selectionEpoch.current;
 const onContinue=async(projectId:string,roundId:string,pairId:string)=>{
  const refreshed=await deadline(targets.refetch());
  if(refreshed.error||!refreshed.data)throw new Error('target unavailable');
  const options=refreshed.data;
  if(selectionEpoch.current!==renderedSelectionEpoch)return;
  const work=options.find(w=>w.projectId===projectId&&w.roundId===roundId&&w.pairId===pairId);
  if(!work)throw new Error('target unavailable');
  choose({...work,stepId:work.steps[0].id});await load();
 };
 const summary=rows.find(r=>r.roundId===target?.roundId&&r.stepId===target?.stepId&&r.summary.state==='saved')?.summary;
 useEffect(()=>{if(follow.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[page,local,activity]);
 const run=async(turn:Turn,admit:boolean)=>{if(locked.current)return;locked.current=true;const token=++epoch.current;
  const update=(text:string)=>{if(token===epoch.current)setActivity({id:turn.executionId,text});};setError('');
  try{update('正在准备回答…');
   if(admit){const account=targets.data?.find(t=>t.roundId===turn.roundId)?.account;const scopes=['user',...(account?['account:'+account]:[])];const preferences=(await Promise.all(scopes.map(scope=>deadline(api.preferences.query({scope}))))).flat();await deadline(api.begin.mutate({conversationId,requestId:turn.executionId,projectId:turn.projectId,roundId:turn.roundId,stepId:turn.stepId,pairId:turn.pairId,body:turn.input!,preferenceRefs:preferences.filter(p=>p.active).map(p=>({scope:p.scope,name:p.name,version:p.version}))}));}
   update('正在使用所选方法处理…');const reply=await deadline(api.executePhase.mutate({executionId:turn.executionId,phase:'reply'}),120000);
   if(token!==epoch.current)return;
   setLocal({...turn,reply});await load();
   if(reply.state==='saved'){update('回答已保存，正在整理本步骤成果…');await deadline(api.executePhase.mutate({executionId:turn.executionId,phase:'summary'}),120000);if(token!==epoch.current)return;await load();}
  }catch{if(token===epoch.current){setActivity({id:turn.executionId,text:'连接暂时中断，已保留本轮请求。'});setError('请在本轮点击重试。');}return;
  }finally{locked.current=false;}
  if(token===epoch.current){setActivity(null);setLocal(null);}
 };
 const send=()=>{if(!canSend||!target||!input.trim()||locked.current)return;const turn:Turn={projectId:target.projectId,roundId:target.roundId,stepId:target.stepId,stepTitle:target.stepTitle,pairId:target.pairId,executionId:crypto.randomUUID(),createdAt:new Date().toISOString(),input:input.trim(),reply:{state:'pending'},summary:{state:'pending'}};setLocal(turn);setInput('');follow.current=true;void run(turn,true);};
 return <div className="flex h-dvh flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]"><AppHeader/><div className="flex min-h-0 flex-1"><ChatSidebar onNewChat={()=>navigate()} onSelectConversation={navigate}/><main className="flex min-w-0 flex-1 flex-col" aria-label="双 Skill 对话">
 <header className="border-b border-[var(--border-primary)] p-4"><h1>连续创作</h1><p className="text-sm text-[var(--text-secondary)]">切换创作步骤后，之前的讨论仍保留在这里。</p><a href="/workbench" className="underline">查看作品与正式报告</a><Button variant="ghost" onClick={()=>setShowArtifact(v=>!v)}>步骤与成果</Button><SliceStartWork onCreated={onContinue}/></header>
 <div ref={scroll} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}} className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6">
 {page?.nextCursor&&<Button variant="outline" onClick={()=>{const before=page.nextCursor;if(!before)return;void deadline(api.conversation.query({conversationId,before})).then(older=>setPage(current=>current?{items:[...current.items,...older.items.filter(x=>!current.items.some(y=>y.executionId===x.executionId))],nextCursor:older.nextCursor}:older)).catch(()=>setError('更早的记录暂时无法读取。'));}}>加载更早的对话</Button>}
 {!page&&!error&&<p role="status">正在读取对话…</p>}
 {turns.map(turn=><section key={turn.executionId} aria-label="一轮对话" className="space-y-5">{turn.input!==null&&<div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--color-primary)] px-4 py-3 text-black">{turn.input}</div>}<div aria-label="助手回答" className="min-w-0 space-y-3">
 {turn.reply.state==='restricted'?<p>这轮内容目前不可访问。</p>:turn.reply.state==='unavailable'?<p>本轮未能交付完整回答，原请求已保留供核对，不会自动重新生成。你可以继续发送新消息。</p>:<>{activity?.id===turn.executionId&&<p role="status" className="text-sm text-[var(--text-secondary)]">{activity.text}</p>}{turn.reply.state==='saved'?<><div className="whitespace-pre-wrap break-words leading-7">{turn.reply.body}</div><Button variant="ghost" onClick={()=>{if(turn.reply.state==='saved')void navigator.clipboard.writeText(turn.reply.body).catch(()=>setError('复制未成功，请重试。'));}}>复制回答</Button></>:!activity&&<p>本轮尚未完成。</p>}
 {turn.summary.state==='unavailable'&&<p>本轮成果未能完成整理，已保存的回答仍可阅读。</p>}
 {(turn.reply.state==='pending'||(turn.reply.state==='saved'&&turn.summary.state==='pending'))&&<Button variant="outline" disabled={locked.current} onClick={()=>void run(turn,turn===local&&!(page?.items.some(r=>r.executionId===turn.executionId)))}>重试</Button>}</>}
 </div></section>)}
 {error&&<p role="alert">{error}</p>}
 {!page&&error&&<Button onClick={()=>void load().catch(()=>setError('暂时无法读取对话，请重试。'))}>重试</Button>}
 </div></div>
 <form onSubmit={e=>{e.preventDefault();send();}} className="border-t border-[var(--border-primary)] p-4"><div className="mx-auto max-w-3xl"><label className="text-sm">使用 Skill 创作<select aria-label="使用 Skill 创作" className="ml-2 max-w-full bg-[var(--bg-secondary)] p-2" value={target?target.roundId+':'+target.stepId+':'+target.pairId:''} onChange={e=>choose(choices.find(r=>r.roundId+':'+r.stepId+':'+r.pairId===e.target.value)??null)}><option value="">{heldTarget?'原选择暂不可用，请重新选择':'请选择要创作的作品与步骤'}</option>{choices.map(r=><option key={r.roundId+':'+r.stepId+':'+r.pairId} value={r.roundId+':'+r.stepId+':'+r.pairId}>{r.purpose==='script'?'脚本':'标题'} · {r.title} · {r.stepTitle}{r.state==='published'?` · 正式 v${r.version}`:''}</option>)}</select></label>
 {identity.error&&<p role="alert">暂时无法验证当前用户。<Button variant="ghost" onClick={()=>void identity.refetch()}>重新验证</Button></p>}
 {(!selectionReady||targets.isFetching||selectedCheck.isFetching)&&<p role="status">正在核对所选作品…</p>}
 {target&&<p aria-label="当前创作目标">{target.title} · {target.state==='published'?`正式 v${target.version}`:'当前草稿'} · {target.stepTitle}</p>}
 {heldTarget&&(selectedCheck.error||(!targets.isFetching&&!target)||(selectedCheck.data&&!selectedCheck.data.executable&&target?.state==='draft'))&&<p role="alert">所选作品或引用目前无法继续创作，原选择和输入已保留。<Button variant="ghost" onClick={()=>{void targets.refetch();void selectedCheck.refetch();}}>重新检查</Button></p>}
 {targets.error&&<p role="alert">暂时无法读取可用作品，请重试。<Button variant="ghost" onClick={()=>void targets.refetch()}>重新读取作品</Button></p>}
 {targets.data&&!choices.length&&<p>当前没有可继续的创作草稿。请从<a className="underline" href="/workbench">已保存的定位报告</a>开始创建作品。</p>}
 <SlicePreferences account={target?.account}/>
 <textarea aria-label="消息" value={input} maxLength={2000} disabled={!canSend} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();send();}}} placeholder="补充需求，或告诉 AI 怎样修改…" className="mt-3 w-full resize-y rounded-xl bg-[var(--bg-secondary)] p-3"/><Button disabled={!canSend||locked.current||!input.trim()} type="submit">发送</Button></div></form>
 </main>{target&&<div className={(showArtifact?'fixed inset-x-0 bottom-0 top-16 z-40 overflow-y-auto bg-[var(--bg-primary)]':'hidden')+' lg:static lg:block lg:w-80 lg:shrink-0 lg:overflow-y-auto'}><Button className="lg:hidden" variant="ghost" onClick={()=>setShowArtifact(false)}>关闭成果</Button><SliceArtifact drafts={artifactDrafts} setDrafts={setArtifactDrafts} target={target} works={targets.data??[]} candidate={summary?.state==='saved'?summary:undefined} onChanged={()=>{recheck();void targets.refetch();void load();}} onContinue={onContinue}/></div>}</div></div>;
}
