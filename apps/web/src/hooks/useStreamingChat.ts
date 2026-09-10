/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState, useCallback, useRef, useEffect } from 'react';
import { createClient } from '@/lib/supabase';
import type { SearchEvidence } from '@repo/api/src/services/providerUsage';
import type { ChatInput, publicChatRequest } from '@/lib/ordinary-chat-request';

export interface StreamMessage {
  id:string; role:'user'|'assistant'; content:string; createdAt:string; isStreaming?:boolean;
  search?:SearchEvidence|null;
  usage?:{inputTokens:number;outputTokens:number;cacheReadTokens?:number}; cost?:{credits:number};
}
type Snapshot=ReturnType<typeof publicChatRequest>;
type Pending={actor:string;requestId:string;input:ChatInput;conversationId:string|null;createdAt:number;snapshot?:Snapshot;stopped?:boolean;absent?:boolean;deliveryError?:string;received?:boolean};
export type ChatProgressPhase = 'preparing'|'waiting'|'searching'|'answering'|'confirming'|'recovering'|null;
interface Options {
  conversationId?:string;moduleId?:string;onMessageStart?:()=>void;
  onMessageComplete?:(message:StreamMessage)=>void;onConversationCreated?:(id:string)=>void;
  onError?:(error:string)=>void;onBalanceChange?:()=>void;onInputSaved?:(content:string)=>void;
}
const supabase=createClient();
const key=(actor:string)=>`ordinary-chat:v1:${actor}`;
function saved(actor:string):Pending[] {
  const prefix=key(actor)+':',entries:Pending[]=[];
  for(let i=0;i<localStorage.length;i++){
    const item=localStorage.key(i);
    if(item?.startsWith(prefix)){
      const value=localStorage.getItem(item);
      if(value)entries.push(JSON.parse(value));
    }
  }
  return entries.sort((a,b)=>a.createdAt-b.createdAt);
}
function persist(p:Pending) {
  // Independent keys prevent a late snapshot in one tab from overwriting an
  // unrelated request created in another tab. The account lock below still
  // serializes selection of a new logical submission for the same conversation.
  // Answers are recovered from the server; avoid filling browser storage with
  // full generations. Keep every unresolved/failed input and only the latest
  // completed discovery record per conversation.
  const stored={...p,snapshot:p.snapshot?{...p.snapshot,content:null}:undefined};
  localStorage.setItem(`${key(p.actor)}:${p.requestId}`,JSON.stringify(stored));
  for(const previous of saved(p.actor)){
    if(previous.requestId!==p.requestId&&previous.createdAt<p.createdAt&&previous.conversationId===p.conversationId&&previous.snapshot?.state==='succeeded'){
      localStorage.removeItem(`${key(p.actor)}:${previous.requestId}`);
    }
  }
}
const unresolved=(p:Pending|null)=>!!p && p.snapshot?.state!=='succeeded' && p.snapshot?.state!=='failed';

export function useStreamingChat(options:Options={}) {
  const [messages,setMessages]=useState<StreamMessage[]>([]),[pending,setPending]=useState<Pending|null>(null);
  const [isLoading,setLoading]=useState(false),[isStreaming,setStreaming]=useState(false),[error,setError]=useState<string|null>(null);
  const [phase,setPhase]=useState<ChatProgressPhase>(null),[recoveryPaused,setRecoveryPaused]=useState(false),[recoveryTick,setRecoveryTick]=useState(0);
  const recoveryAttempts=useRef(0);
  const [conversationId,setConversation]=useState<string|null>(options.conversationId??null);
  const opts=useRef(options);opts.current=options;
  const current=useRef<Pending|null>(null),conversation=useRef<string|null>(options.conversationId??null);
  const busy=useRef(false),epoch=useRef(0),alive=useRef(true),controller=useRef<AbortController|null>(null);
  const completed=useRef(new Set<string>()),historyEpoch=useRef(0);
  const save=useCallback((p:Pending)=>{persist(p);current.current=p;setPending(p);},[]);
  const apply=useCallback((snapshot:Snapshot,p:Pending)=>{
    if(!alive.current || current.current?.requestId!==p.requestId)return;
    const next={...p,conversationId:snapshot.conversationId,snapshot,absent:false,deliveryError:undefined};save(next);
    if(conversation.current!==snapshot.conversationId){conversation.current=snapshot.conversationId;setConversation(snapshot.conversationId);opts.current.onConversationCreated?.(snapshot.conversationId);}
    const userId=snapshot.userMessageId??`user-${p.requestId}`,assistantId=snapshot.assistantMessageId??`assistant-${p.requestId}`;
    const answer:StreamMessage={id:assistantId,role:'assistant',content:snapshot.content??'',createdAt:new Date().toISOString(),search:snapshot.search,
      ...(snapshot.state==='succeeded'?{usage:snapshot.usage??undefined,cost:{credits:snapshot.billing.credits??0}}:{})};
    setMessages(previous=>{
      const without=previous.filter(m=>![userId,assistantId,`user-${p.requestId}`,`assistant-${p.requestId}`].includes(m.id));
      return [...without,{id:userId,role:'user',content:snapshot.input.message,createdAt:new Date().toISOString()},...(snapshot.content?[answer]:[])];
    });
    if(snapshot.state==='succeeded'&&!completed.current.has(p.requestId)){completed.current.add(p.requestId);opts.current.onMessageComplete?.(answer);opts.current.onBalanceChange?.();}
    if(snapshot.state==='failed')opts.current.onBalanceChange?.();
    setPhase(['succeeded','failed'].includes(snapshot.state)?null:snapshot.state==='responded'?'confirming':'recovering');
    setError(null);
  },[save]);
  const recover=useCallback(async(settings:{quiet?:boolean}={})=>{
    const p=current.current;if(!p||busy.current)return;
    const generation=epoch.current;busy.current=true;if(!settings.quiet){setLoading(true);setPhase('recovering');setRecoveryPaused(false);recoveryAttempts.current=0;}
    try {
      const {data:{session}}=await supabase.auth.getSession();
      if(!session||session.user.id!==p.actor)throw new Error('请使用原账号登录后恢复请求。');
      const response=await fetch(`/api/ai/requests?requestId=${p.requestId}`,{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
      const data=await response.json();
      if(!alive.current||epoch.current!==generation)return;
      if(response.status===404){save({...p,absent:true});setError([p.deliveryError,'尚未确认服务器接收。可使用原请求标识继续提交。'].filter(Boolean).join(' '));return;}
      if(!response.ok){if(response.status===401||response.status===403)setRecoveryPaused(true);throw new Error(data.error??'暂时无法读取请求状态。');}
      apply(data.request,p);return data.request as Snapshot;
    }catch(e){if(alive.current&&epoch.current===generation)setError(e instanceof Error?e.message:'恢复暂时不可用。');}
    finally{if(epoch.current===generation){busy.current=false;if(alive.current){if(!settings.quiet)setLoading(false);setRecoveryTick(v=>v+1);}}}
  },[apply,save]);
  useEffect(()=>{
    alive.current=true;
    let cancelled=false;
    void (async()=>{
      try {
        const {data:{session}}=await supabase.auth.getSession();if(!session||cancelled)return;
        const entries=saved(session.user.id);
        const p=entries.findLast(v=>v.actor===session.user.id && (opts.current.conversationId
          ? v.conversationId===opts.current.conversationId
          : !v.conversationId && v.input.moduleId===(opts.current.moduleId??null)));
        if(p){current.current=p;setPending(p);setMessages(previous=>[...previous.filter(m=>m.id!==`user-${p.requestId}`),{id:`user-${p.requestId}`,role:'user',content:p.input.message,createdAt:new Date().toISOString()}]);await recover();}
      }catch{if(!cancelled)setError('无法读取本地请求记录，请检查浏览器存储。');}
    })();
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_OUT'||(current.current&&session&&current.current.actor!==session.user.id)){
        epoch.current++;controller.current?.abort();current.current=null;setPending(null);setMessages([]);busy.current=false;setLoading(false);setStreaming(false);
      }
    });
    return()=>{cancelled=true;alive.current=false;epoch.current++;controller.current?.abort();subscription.unsubscribe();};
  },[recover]);
  useEffect(()=>{
    if(!unresolved(pending)||pending?.absent||pending?.stopped||isStreaming||recoveryPaused||recoveryAttempts.current>=12)return;
    const timer=setTimeout(()=>{recoveryAttempts.current++;void recover({quiet:true});},Math.min(2000*2**Math.min(recoveryAttempts.current,3),15000));
    return()=>clearTimeout(timer);
  },[pending,recover,isStreaming,recoveryPaused,recoveryTick]);

  const transmit=useCallback(async(p:Pending)=>{
    const generation=epoch.current;
    try {
      const {data:{session}}=await supabase.auth.getSession();
      if(!session||session.user.id!==p.actor)throw new Error('请重新登录后恢复原请求。');
      if(!alive.current||epoch.current!==generation)return;
      controller.current=new AbortController();setLoading(true);setStreaming(true);setPhase('preparing');setRecoveryPaused(false);recoveryAttempts.current=0;setError(null);
      opts.current.onMessageStart?.();
      const response=await fetch('/api/ai/stream',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({...p.input,requestId:p.requestId}),signal:controller.current.signal});
      if(!response.ok){
        const body=await response.json().catch(()=>null);
        const reason=typeof body?.error==='string' && body.error.trim() ? body.error.slice(0,500) : '请求暂时失败，请恢复原请求。';
        // Keep the server rejection separately from receipt uncertainty. A
        // subsequent 404 must not erase the reason or authorize a new ID.
        if(alive.current&&epoch.current===generation&&current.current?.requestId===p.requestId)save({...current.current,deliveryError:reason});
        throw new Error(reason);
      }
      if(response.headers.get('content-type')?.includes('application/json')){
        const data=await response.json();if(alive.current&&epoch.current===generation)apply(data.request,p);
      }else{
        const reader=response.body?.getReader();if(!reader)throw new Error('响应丢失，请恢复原请求。');
        const decoder=new TextDecoder();let buffer='',complete=false;
        for(;;){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});
          let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.startsWith('data: '))continue;
            const event=JSON.parse(line.slice(6));if(!alive.current||epoch.current!==generation)continue;
            if(event.type==='init'&&event.requestId===p.requestId&&event.conversationId){
              const nextPending={...current.current!,conversationId:event.conversationId,received:true};save(nextPending);setPhase('waiting');
              if(conversation.current!==event.conversationId){conversation.current=event.conversationId;setConversation(event.conversationId);opts.current.onConversationCreated?.(event.conversationId);}
            }
            if(event.requestId!==p.requestId)continue;
            if(event.type==='search_started')setPhase('searching');
            if(event.type==='content'&&typeof event.content==='string'){
              // Checked server text is a provisional preview. Only the saved
              // authenticated result can confirm completion, sources and charges.
              setPhase(event.final?'confirming':'answering');
              const answer:StreamMessage={id:`assistant-${p.requestId}`,role:'assistant',content:event.content,createdAt:new Date().toISOString(),isStreaming:!event.final};
              setMessages(previous=>[...previous.filter(m=>m.id!==answer.id),answer]);
            }
            if(event.type==='error')throw new Error(typeof event.error==='string'?event.error:'响应中断，正在确认原请求。');
            if(event.type==='complete'){complete=true;setPhase('confirming');break;}

          }
          if(complete){await reader.cancel();break;}
        }
        if(!complete)throw new Error('响应未确认完成，正在恢复原请求状态。');
      }
    }catch(e){if(alive.current&&epoch.current===generation)setError(e instanceof Error&&e.name!=='AbortError'?e.message:null);}
    finally {
      if(alive.current&&epoch.current===generation){controller.current=null;setLoading(false);setStreaming(false);busy.current=false;await recover();}
    }
  },[apply,recover,save]);

  const sendMessage=useCallback(async(content:string,sendOptions:{modelId?:string;moduleId?:string}={})=>{
    if(!content.trim()||busy.current||unresolved(current.current))return;
    busy.current=true;setPhase('preparing');const generation=epoch.current;
    try {
      const {data:{session}}=await supabase.auth.getSession();if(!session)throw new Error('请先登录，输入内容已保留。');
      if(!alive.current||epoch.current!==generation)return;
      const input:ChatInput={message:content.trim(),conversationId:conversation.current,modelId:sendOptions.modelId??null,moduleId:sendOptions.moduleId??opts.current.moduleId??null};
      const choose=()=>{
        const existing=saved(session.user.id).findLast(v=>unresolved(v)&&v.conversationId===input.conversationId&&v.input.moduleId===input.moduleId);
        if(existing){if(JSON.stringify(existing.input)!==JSON.stringify(input))throw new Error('此对话还有需要恢复的请求，请先确认原请求状态。');return existing;}
        const p:Pending={actor:session.user.id,requestId:crypto.randomUUID(),input,conversationId:input.conversationId,createdAt:Date.now()};persist(p);return p;
      };
      const p=navigator.locks?await navigator.locks.request(key(session.user.id),choose):choose();
      if(!alive.current||epoch.current!==generation)return;
      save(p);opts.current.onInputSaved?.(content);
      setMessages(previous=>[...previous,{id:`user-${p.requestId}`,role:'user',content:p.input.message,createdAt:new Date().toISOString()}]);
      await transmit(p);
    }catch(e){busy.current=false;if(alive.current)setError(e instanceof Error?e.message:'请求无法保存在浏览器中，输入内容已保留。');}
  },[save,transmit]);

  const resume=useCallback(async()=>{
    const p=current.current;if(!p||busy.current||p.snapshot)return;
    busy.current=true;save({...p,absent:false});await transmit({...p,absent:false}); // Explicit delivery retry, same immutable ID.
  },[transmit,save]);
  const retryFailed=useCallback(async()=>{
    const p=current.current;if(!p||busy.current||p.snapshot?.state!=='failed')return;
    const fresh=await recover();if(fresh?.state!=='failed')return;
    // A separate user action creates a new generation after a proven release.
    await sendMessage(p.input.message,{modelId:p.input.modelId??undefined,moduleId:p.input.moduleId??undefined});
  },[recover,sendMessage]);
  const abort=useCallback(()=>{
    const p=current.current;if(!p)return;
    try{save({...p,stopped:true});}catch{}
    controller.current?.abort();setStreaming(false);setLoading(false);setPhase(null);
    void (async()=>{const {data:{session}}=await supabase.auth.getSession();if(session?.user.id===p.actor)await fetch(`/api/ai/requests?requestId=${p.requestId}`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`}}).catch(()=>{});})();
  },[save]);
  const loadHistory=useCallback(async(id:string)=>{
    const version=++historyEpoch.current;
    try {
      const {data,error}=await supabase.from('messages').select('id,role,content,created_at').eq('conversation_id',id).eq('is_deleted','false').order('created_at',{ascending:true}).limit(50);
      if(error)throw error;
      if(!alive.current||version!==historyEpoch.current||conversation.current!==id)return;
      conversation.current=id;setConversation(id);
      setMessages(previous=>{
        const history=data?.map(m=>({id:m.id,role:m.role as 'user'|'assistant',content:m.content,createdAt:m.created_at}))??[];
        const ids=new Set(history.map(m=>m.id));
        return [...history,...previous.filter(m=>!ids.has(m.id))];
      });
      if(current.current)await recover();
    }catch{if(alive.current&&version===historyEpoch.current)setError('加载历史消息失败，请稍后重试。');}
  },[recover]);
  const clearChat=useCallback(()=>{
    epoch.current++;historyEpoch.current++;controller.current?.abort();busy.current=false;current.current=null;conversation.current=null;
    setPending(null);setConversation(null);setMessages([]);setLoading(false);setStreaming(false);setPhase(null);setError(null);
  },[]);
  const requestStatus=pending?.snapshot?.state??(pending?(pending.received?'running':'unconfirmed'):null);
  return {conversationId,messages,isLoading,isStreaming,error,modelUsed:pending?.snapshot?.modelUsed??null,
    sendMessage,abort,loadHistory,clearChat,recover,resume,retryFailed,
    phase,startedAt:pending?.createdAt??null,recoveryPaused,
    requestStatus,requestAbsent:pending?.absent===true,requestInput:pending?.input.message??null,hasUnresolvedRequest:unresolved(pending),
    stopped:pending?.stopped||pending?.snapshot?.stopped,billing:pending?.snapshot?.billing??null};
}
export default useStreamingChat;
