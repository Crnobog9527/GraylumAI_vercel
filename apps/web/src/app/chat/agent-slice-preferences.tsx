/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import {useRef,useState} from 'react';
import {trpc} from '@/trpc/client';
import {Button} from '@/components/ui/button';
export function SlicePreferences({account}:{account?:string|null}){
 const [accountOnly,setAccountOnly]=useState(false),[value,setValue]=useState(''),[error,setError]=useState('');
 const scope=accountOnly&&account?'account:'+account:'user';
 const query=trpc.agentSlice.preferences.useQuery({scope},{retry:false,refetchOnWindowFocus:true});
 const change=trpc.agentSlice.confirmPreference.useMutation();
 const request=useRef<{key:string;id:string}|null>(null);
 const current=query.data?.find(p=>p.name==='写作偏好');
 const save=async(action:'confirm'|'delete')=>{if(change.isPending||!query.data)return;
  const payload={scope,name:'写作偏好',expectedVersion:current?.version??0,confirmed:true as const,action,...(action==='confirm'?{value:value.trim()}:{})};
  const key=JSON.stringify(payload);if(request.current?.key!==key)request.current={key,id:crypto.randomUUID()};
  try{setError('');await change.mutateAsync({...payload,requestId:request.current.id});setValue('');await query.refetch();}catch{setError('偏好未能保存，请重新读取后重试。');}
 };
 return <details className="my-3 text-sm"><summary>我的创作偏好</summary><div className="space-y-2 py-3">
 {account&&<label><input type="checkbox" checked={accountOnly} onChange={e=>{setAccountOnly(e.target.checked);setValue('');}}/> 仅用于当前账号</label>}
 <p>{scope==='user'?'用于我的新请求，也用于新聊天。':'仅用于这个账号的新请求。'}只有点击确认后才会保存。</p>
 {query.isPending?<p>正在读取偏好…</p>:query.error?<p role="alert">暂时无法读取偏好。</p>:<p>已确认：{current?.active?current.value:'尚未设置'}</p>}
 <textarea aria-label="写作偏好" value={value} maxLength={1000} onChange={e=>setValue(e.target.value)} placeholder="例如：口播稿使用简洁中文，先给具体例子。" className="w-full rounded-lg bg-[var(--bg-secondary)] p-2"/>
 <Button disabled={!value.trim()||change.isPending||!query.data} onClick={()=>void save('confirm')}>确认保存偏好</Button>
 {current?.active&&<Button variant="outline" disabled={change.isPending} onClick={()=>void save('delete')}>删除这条偏好</Button>}
 {error&&<p role="alert">{error}</p>}
 </div></details>;
}
