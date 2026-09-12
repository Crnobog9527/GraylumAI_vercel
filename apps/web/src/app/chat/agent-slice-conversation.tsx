/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import {useEffect,useRef,useState} from 'react';
import type {inferRouterOutputs} from '@trpc/server';
import type {AppRouter} from '@repo/api/src/root';
import {trpc} from '@/trpc/client';
import {AppHeader} from '@/components/layout/AppHeader';
import {ChatSidebar} from '@/components/chat/ChatSidebar';
import {Button} from '@/components/ui/button';
type Page=inferRouterOutputs<AppRouter>['agentSlice']['conversation'];
type Turn=Page['items'][number];
async function deadline<T>(promise:Promise<T>,ms=10000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('连接暂时没有响应，请重试。')),ms);})]).finally(()=>clearTimeout(timer));}
/** Same official chat route and shared application shell. No duplicate body store. */
export function AgentSliceConversation({conversationId,navigate}:{conversationId:string;navigate:(id?:string)=>void}){
 const api=trpc.useUtils().client.agentSlice;
 const [page,setPage]=useState<Page|null>(null),[input,setInput]=useState(''),[error,setError]=useState('');
 const [local,setLocal]=useState<Turn|null>(null),[activity,setActivity]=useState<{id:string;text:string}|null>(null);
 const [selected,setSelected]=useState('');const epoch=useRef(0),locked=useRef(false),scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
 const load=async()=>{const value=await deadline(api.conversation.query({conversationId}));setPage(value);return value;};
 useEffect(()=>{let alive=true;const refresh=()=>{void deadline(api.conversation.query({conversationId})).then(value=>{if(alive){setPage(value);setError('');}}).catch(()=>{if(alive){setPage(null);setError('暂时无法读取对话，请重试。');}});};refresh();const visible=()=>{if(document.visibilityState==='visible')refresh();};window.addEventListener('online',refresh);document.addEventListener('visibilitychange',visible);return()=>{alive=false;epoch.current++;window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',visible);};},[api,conversationId]);
 const rows=[...(page?.items??[])];if(local&&!rows.some(r=>r.executionId===local.executionId))rows.unshift(local);
 // Server supplies descending tuple order; preserve it rather than reparsing timestamps.
 const turns=rows.slice().reverse();const target=rows.find(r=>r.roundId+':'+r.stepId===selected)??rows[0];
 useEffect(()=>{if(follow.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[page,local,activity]);
 const run=async(turn:Turn,admit:boolean)=>{if(locked.current)return;locked.current=true;const token=++epoch.current;
  const update=(text:string)=>{if(token===epoch.current)setActivity({id:turn.executionId,text});};setError('');
  try{update('正在准备回答…');
   if(admit){const preferences=await deadline(api.preferences.query({scope:'user'}));await deadline(api.begin.mutate({conversationId,requestId:turn.executionId,projectId:turn.projectId,roundId:turn.roundId,stepId:turn.stepId,pairId:turn.pairId,body:turn.input!,preferenceRefs:preferences.filter(p=>p.active).map(p=>({scope:p.scope,name:p.name,version:p.version}))}));}
   update('正在使用所选方法处理…');const reply=await deadline(api.executePhase.mutate({executionId:turn.executionId,phase:'reply'}),120000);
   if(token!==epoch.current)return;
   setLocal({...turn,reply});await load();
   if(reply.state==='saved'){update('回答已保存，正在整理本步骤成果…');await deadline(api.executePhase.mutate({executionId:turn.executionId,phase:'summary'}),120000);if(token!==epoch.current)return;await load();}
  }catch{if(token===epoch.current){setActivity({id:turn.executionId,text:'连接暂时中断，已保留本轮请求。'});setError('请在本轮点击重试。');}return;
  }finally{locked.current=false;}
  if(token===epoch.current){setActivity(null);setLocal(null);}
 };
 const send=()=>{if(!target||!input.trim()||locked.current)return;const turn:Turn={...target,executionId:crypto.randomUUID(),createdAt:new Date().toISOString(),input:input.trim(),reply:{state:'pending'},summary:{state:'pending'}};setLocal(turn);setInput('');follow.current=true;void run(turn,true);};
 return <div className="flex h-dvh flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]"><AppHeader/><div className="flex min-h-0 flex-1"><ChatSidebar onNewChat={()=>navigate()} onSelectConversation={navigate}/><main className="flex min-w-0 flex-1 flex-col" aria-label="双 Skill 对话">
 <header className="border-b border-[var(--border-primary)] p-4"><h1>连续创作</h1><p className="text-sm text-[var(--text-secondary)]">切换创作步骤后，之前的讨论仍保留在这里。</p><a href="/workbench" className="underline">查看作品与正式报告</a></header>
 <div ref={scroll} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}} className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6">
 {page?.nextCursor&&<Button variant="outline" onClick={()=>{const before=page.nextCursor;if(!before)return;void deadline(api.conversation.query({conversationId,before})).then(older=>setPage(current=>current?{items:[...current.items,...older.items.filter(x=>!current.items.some(y=>y.executionId===x.executionId))],nextCursor:older.nextCursor}:older)).catch(()=>setError('更早的记录暂时无法读取。'));}}>加载更早的对话</Button>}
 {!page&&!error&&<p role="status">正在读取对话…</p>}
 {turns.map(turn=><section key={turn.executionId} aria-label="一轮对话" className="space-y-5">{turn.input!==null&&<div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--accent-primary)] px-4 py-3 text-black">{turn.input}</div>}<div aria-label="助手回答" className="min-w-0 space-y-3">
 {turn.reply.state==='restricted'?<p>这轮内容目前不可访问。</p>:<>{activity?.id===turn.executionId&&<p role="status" className="text-sm text-[var(--text-secondary)]">{activity.text}</p>}{turn.reply.state==='saved'?<><div className="whitespace-pre-wrap break-words leading-7">{turn.reply.body}</div><Button variant="ghost" onClick={()=>{if(turn.reply.state==='saved')void navigator.clipboard.writeText(turn.reply.body).catch(()=>setError('复制未成功，请重试。'));}}>复制回答</Button></>:!activity&&<p>本轮尚未完成。</p>}
 {(turn.reply.state==='pending'||turn.summary.state==='pending')&&<Button variant="outline" disabled={locked.current} onClick={()=>void run(turn,turn===local&&!(page?.items.some(r=>r.executionId===turn.executionId)))}>重试</Button>}</>}
 </div></section>)}
 {error&&<p role="alert">{error}</p>}
 {!page&&error&&<Button onClick={()=>void load().catch(()=>setError('暂时无法读取对话，请重试。'))}>重试</Button>}
 </div></div>
 <form onSubmit={e=>{e.preventDefault();send();}} className="border-t border-[var(--border-primary)] p-4"><div className="mx-auto max-w-3xl"><label className="text-sm">继续讨论的步骤<select aria-label="继续讨论的步骤" className="ml-2 bg-[var(--bg-secondary)] p-2" value={target?target.roundId+':'+target.stepId:''} onChange={e=>setSelected(e.target.value)}>{rows.filter((r,i)=>rows.findIndex(x=>x.roundId===r.roundId&&x.stepId===r.stepId)===i).map((r,i)=><option key={r.executionId} value={r.roundId+':'+r.stepId}>{r.stepTitle} · 作品 {i+1}</option>)}</select></label><textarea aria-label="消息" value={input} maxLength={2000} disabled={!target} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();send();}}} placeholder="补充需求，或告诉 AI 怎样修改…" className="mt-3 w-full resize-y rounded-xl bg-[var(--bg-secondary)] p-3"/><Button disabled={!target||locked.current||!input.trim()} type="submit">发送</Button></div></form>
 </main></div></div>;
}
