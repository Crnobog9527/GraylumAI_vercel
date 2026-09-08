'use client';
import { Suspense } from 'react';
import { ChatEntry } from './skill-entry';
export default function ChatPage() {
 return <Suspense fallback={<p role="status">正在加载对话…</p>}><ChatEntry/></Suspense>;
}
