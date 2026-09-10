/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useEffect, useState } from 'react';
import { Loader2, Search, Sparkles } from 'lucide-react';
import type { ChatProgressPhase } from '@/hooks/useStreamingChat';

const labels = {
  preparing: ['正在准备请求', '正在检查连接和本次请求。'],
  waiting: ['正在思考', '请求已接收，正在等待模型返回回答。'],
  searching: ['联网处理中', '已允许搜索，正在等待模型搜索或整理结果；查询次数将在执行证据确认后显示。'],
  answering: ['正在回答', '回答正在逐步生成，完成后确认来源和用量。'],
  confirming: ['正在确认结果', '正在确认原回答的保存和费用状态，不会重新生成。'],
  recovering: ['正在确认原请求', '正在查询原请求状态，不会重新发送消息。'],
};
export function ChatProgress({phase,startedAt}:{phase:ChatProgressPhase;startedAt:number|null}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!phase)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[phase]);
  if(!phase)return null;
  const [title,description]=labels[phase],seconds=Math.max(0,Math.floor((now-(startedAt??now))/1000));
  const Icon=phase==='searching'?Search:phase==='waiting'?Sparkles:Loader2;
  return <div data-testid="chat-progress" className="mx-4 my-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
    <style>{'@keyframes graylum-chat-activity { from { transform: translateX(-100%); } to { transform: translateX(400%); } }'}</style>
    <div className="flex items-center justify-between gap-3 text-sm"><div role="status" className="flex items-center gap-2"><Icon className="h-4 w-4 motion-safe:animate-pulse"/><span>{title}</span></div><span className="tabular-nums text-[var(--text-tertiary)]">已等待 {seconds} 秒</span></div>
    <div role="progressbar" aria-label={title} aria-valuetext="进行中，完成时间待确认" className="mt-3 h-1 overflow-hidden rounded bg-[var(--border-color)]"><div className="h-full w-1/3 rounded bg-[var(--color-primary)] motion-safe:animate-[graylum-chat-activity_1.8s_ease-in-out_infinite] motion-reduce:w-full"/></div>
    <p className="mt-2 text-xs text-[var(--text-tertiary)]">{description}{seconds>=30?' 耗时较长，可以停止等待；后台请求可能继续执行。':''}</p>
  </div>;
}
