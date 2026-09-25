'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/trpc/client';

/** Continue an account's own draft, never the shared source planning chat. */
export function useAccountDiscussion(){
 const router=useRouter(),utils=trpc.useUtils();
 const begin=trpc.opc.accountStrategyBegin.useMutation();
 const busy=useRef(false);
 const [opening,setOpening]=useState(false),[error,setError]=useState('');
 async function open(accountProjectId:string,onOpened?:()=>void){
  if(busy.current)return;
  busy.current=true;setOpening(true);setError('');
  const key='opc-account-discussion:'+accountProjectId;
  try{
   const [library,history]=await Promise.all([utils.opc.library.fetch({search:'',from:null,to:null}),utils.opc.accountStrategyHistory.fetch({accountProjectId})]);
   const accounts=(library.businesses as Array<{accounts:Array<{projectId:string;strategyDraftId?:string;pendingStrategyDraftId?:string|null;sourceVersionId?:string|null}>}>).flatMap(business=>business.accounts);
   const account=accounts.find(value=>value.projectId===accountProjectId);
   if(!account?.sourceVersionId||!account.strategyDraftId)throw new Error('OPC_DENIED');
   let draftId=account.pendingStrategyDraftId??account.strategyDraftId;
   const retained=sessionStorage.getItem(key);
   // The first account discussion forks the shared source using the existing
   // account revision operation. Later visits retain the same chat and history.
   if(retained||(!account.pendingStrategyDraftId&&(history as Array<{source:string}>)[0]?.source!=='account')){
    const requestId=retained??crypto.randomUUID();
    sessionStorage.setItem(key,requestId);
    const result=await begin.mutateAsync({accountProjectId,requestId}) as {draftId:string};
    draftId=result.draftId;sessionStorage.removeItem(key);
    await utils.opc.library.invalidate();
   }
   router.push('/positioning/'+draftId);
   onOpened?.();
  }catch(cause){
   const code=cause instanceof Error?cause.message:'';
   if(['OPC_DENIED','OPC_SOURCE_DENIED','OPC_REGISTRATION','OPC_REQUEST_CONFLICT','OPC_VERSION_CONFLICT'].includes(code))sessionStorage.removeItem(key);
   setError('暂未能打开此账号的策略讨论，请重试。已保存的定位保留。');
  }finally{busy.current=false;setOpening(false);}
 }
 return {open,opening,error};
}
