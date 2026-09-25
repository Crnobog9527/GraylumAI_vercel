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
   const requestId=sessionStorage.getItem(key)??crypto.randomUUID();
   sessionStorage.setItem(key,requestId);
   // The server retains this account's existing draft or starts its exact
   // source revision. It also repairs proven untouched legacy fields in place.
   const result=await begin.mutateAsync({accountProjectId,requestId}) as {draftId:string};
   const draftId=result.draftId;sessionStorage.removeItem(key);
   await utils.opc.library.invalidate();
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
