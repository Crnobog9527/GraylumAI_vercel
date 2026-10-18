/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  buildSubmit, CONSENT_TEXT, formFromEntry, FOUNDER_WALL_COPY_VERSION, PLATFORMS, type FormValue, type FounderMemberView,
} from './founderMemberView';

export interface WallSubmit { entry: Record<string, unknown>; consentVersion: string }

export function FounderWallForm({ view, pending, serverError, onSubmit }: {
  view: FounderMemberView; pending: boolean; serverError: string | null; onSubmit: (value: WallSubmit) => void;
}) {
  const [form, setForm] = useState<FormValue>(() => formFromEntry(view));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<FormValue>) => setForm(current => ({ ...current, ...patch }));
  const setAccount = (index: number, patch: Partial<FormValue['accounts'][number]>) =>
    set({ accounts: form.accounts.map((item, at) => (at === index ? { ...item, ...patch } : item)) });
  const stale = view.consent.currentVersion !== FOUNDER_WALL_COPY_VERSION;

  function submit() {
    const built = buildSubmit(form);
    if ('error' in built) { setProblem(built.error); return; }
    setProblem(null);
    onSubmit(built);
  }

  return <div className="mt-4 space-y-3" data-testid="founder-wall-form">
    <div className="space-y-1"><Label htmlFor="fw-name">展示名（最多 40 字）</Label>
      <Input id="fw-name" value={form.displayName} maxLength={40} onChange={event => set({ displayName: event.target.value })} /></div>
    {form.accounts.map((item, index) => <div key={index} className="grid gap-2 sm:grid-cols-[8rem_1fr_2fr]">
      <select aria-label={`社媒平台 ${index + 1}`} value={item.platform} onChange={event => setAccount(index, { platform: event.target.value })}
        className="h-9 rounded-md border bg-transparent px-2 text-sm" style={{ borderColor: 'var(--border-primary)' }}>
        {PLATFORMS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <Input aria-label={`账号名 ${index + 1}`} placeholder="账号名" value={item.handle} maxLength={60}
        onChange={event => setAccount(index, { handle: event.target.value })} />
      <Input aria-label={`主页链接 ${index + 1}`} placeholder="https:// 主页链接" value={item.url} maxLength={2048}
        onChange={event => setAccount(index, { url: event.target.value })} />
    </div>)}
    {form.accounts.length < 3 && <Button type="button" variant="outline" size="sm"
      onClick={() => set({ accounts: [...form.accounts, { platform: 'douyin', handle: '', url: '' }] })}>再加一个社媒账号（最多 3 个）</Button>}
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="fw-product">产品名（可选）</Label>
        <Input id="fw-product" value={form.productName} maxLength={60} onChange={event => set({ productName: event.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor="fw-product-url">产品链接（可选）</Label>
        <Input id="fw-product-url" value={form.productUrl} maxLength={2048} onChange={event => set({ productUrl: event.target.value })} /></div>
    </div>
    <div className="space-y-1"><Label htmlFor="fw-intro">一句话介绍（最多 120 字，可选）</Label>
      <Input id="fw-intro" value={form.intro} maxLength={120} onChange={event => set({ intro: event.target.value })} /></div>
    <div className="flex items-start gap-2">
      <Checkbox id="fw-consent" checked={form.consent} onCheckedChange={next => set({ consent: next === true })} />
      <Label htmlFor="fw-consent" className="text-sm leading-5">{CONSENT_TEXT}</Label>
    </div>
    {stale && <p role="status" className="text-sm">说明正在更新，请刷新页面后再提交。</p>}
    {(problem || serverError) && <p role="alert" className="text-sm" style={{ color: '#fca5a5' }}>{problem ?? serverError}</p>}
    <Button type="button" disabled={pending || stale} onClick={submit} data-testid="founder-wall-submit">
      {view.entry ? '更新并重新提交审核' : '提交审核'}
    </Button>
  </div>;
}
