/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Gavel, Loader2, Save } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { modelLabel } from './reportModelView';
import {
  affectsRunning, allSkills, countRunning, draftProblems, PRICE_LIMITS, REVIEW_PAGE, ROLE_CODES, ROLE_LABELS, SEAT_CODES,
  settingsErrorText, TOKEN_LIMITS, toSaved,
  warningText,
  type FusionSettingsValue, type ReviewSettings,
} from './fusionReviewSettingsView';

const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };
const muted = { color: 'var(--text-tertiary)' };
const selectClass = 'h-9 w-full rounded-md border px-2 text-sm';
const selectStyle = { background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' };

/**
 * 评审团设置（FUSION-REVIEW PR-5，Master Plan §4.5）：开关、3 位评审和汇总用哪个模型、评审 Skill、轮数、意见和汇总长度、
 * 单次预算、每位评审和汇总的显示名。整份设置一起保存（fusionSettings.update），服务端会再校验模型和 Skill；
 * 换模型、换 Skill 或关掉评审团时，先提示正在进行的评审后续轮次会失败。
 */
export function FusionReviewSettings() {
  const settings = trpc.fusionSettings.get.useQuery(undefined, { staleTime: 0, retry: false });
  // Outside the keyed form: the form remounts with the saved value, and the notice (and any warning) must stay.
  const [notice, setNotice] = useState<Notice | null>(null);
  if (settings.isLoading) return <SettingsCard><p style={muted}>正在读取评审团设置…</p></SettingsCard>;
  if (!settings.data) {
    return (
      <SettingsCard>
        <p role="alert" style={{ color: 'var(--color-destructive)' }}>{settingsErrorText(settings.error)}</p>
        <Button variant="outline" onClick={() => void settings.refetch()}>重新读取</Button>
      </SettingsCard>
    );
  }
  return <ReviewForm key={JSON.stringify(settings.data.review)} saved={settings.data} onSaved={() => settings.refetch()}
    notice={notice} setNotice={setNotice} />;
}

function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <Card data-testid="admin-settings-fusion-review" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Gavel className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />评审团设置
        </CardTitle>
        <CardDescription style={muted}>
          定位报告出来后，3 位评审各自提意见、意见不一时辩论一轮，再由汇总写出修订稿。用户只看到这里设置的显示名，看不到模型名。
          保存后新开始的评审使用新设置。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

type Notice = { tone: 'ok' | 'error'; text: string };

function ReviewForm({ saved, onSaved, notice, setNotice }: {
  saved: FusionSettingsValue; onSaved: () => Promise<unknown>; notice: Notice | null; setNotice: (notice: Notice | null) => void;
}) {
  const [review, setReview] = useState<ReviewSettings>(() => ({ ...saved.review,
    reviewerModelIds: SEAT_CODES.map((_, index) => saved.review.reviewerModelIds[index] ?? '') }));
  // Checked by the Fusion admission for each purpose (not the report one), the same check a save of an enabled panel runs.
  const models = trpc.fusionSettings.models.useQuery(undefined, { staleTime: 0, retry: false });
  const names = trpc.settings.getSummaryModels.useQuery({ use: 'skill' });
  const utils = trpc.useUtils();
  // Every Skill, not only the first page of 50.
  const skills = useQuery({ queryKey: ['fusion-review-settings', 'skills'], retry: false,
    queryFn: async () => ({ skills: await allSkills(offset => utils.skills.list.fetch({ offset })) }) });
  const update = trpc.fusionSettings.update.useMutation();
  const inFlight = useRef(false);
  const set = (patch: Partial<ReviewSettings>) => { setReview(value => ({ ...value, ...patch })); setNotice(null); };
  const problems = draftProblems(review);
  const dirty = JSON.stringify(toSaved(saved, review).review) !== JSON.stringify(saved.review);
  const reviewers = (models.data?.models ?? []).filter(model => model.review);
  const summaries = (models.data?.models ?? []).filter(model => model.summary);
  const published = (skills.data?.skills ?? []).filter(skill => skill.status === 'published');

  async function save() {
    if (inFlight.current || !dirty || problems.length) return;
    inFlight.current = true;
    setNotice(null);
    try {
      if (affectsRunning(saved.review, review)) {
        const running = await countRunning(before => utils.fusionSettings.reviews.fetch({ limit: REVIEW_PAGE, ...(before ? { before } : {}) }));
        if (running > 0 && !window.confirm(`有 ${running} 个评审正在进行，保存后它们的后续轮次会失败。确定保存吗？`)) return;
      }
      const result = await update.mutateAsync(toSaved(saved, review));
      setNotice({ tone: 'ok', text: result.warnings.length ? result.warnings.map(warningText).join(' ') : '已保存。新开始的评审使用这个设置。' });
      await onSaved();
    } catch (error) {
      setNotice({ tone: 'error', text: settingsErrorText(error) });
    } finally {
      inFlight.current = false;
    }
  }

  const modelSelect = (id: string, value: string, onChange: (value: string) => void, options: readonly { id: string; name: string }[]) => (
    <select id={id} className={selectClass} style={selectStyle} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">未选择</option>
      {options.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      {value && !options.some(model => model.id === value)
        ? <option value={value}>{modelLabel(value, names.data)}{models.data ? '（当前不可用）' : ''}</option> : null}
    </select>
  );
  const nameInput = (id: string, value: string, onChange: (value: string) => void) => (
    <Input id={id} value={value} maxLength={40} onChange={event => onChange(event.target.value)} />
  );

  return (
    <SettingsCard>
      <div className="flex items-center gap-3">
        <Switch id="fusion-review-enabled" checked={review.enabled} onCheckedChange={enabled => set({ enabled })} />
        <Label htmlFor="fusion-review-enabled" style={{ color: 'var(--text-secondary)' }}>开启评审团（关掉后定位页不显示入口）</Label>
      </div>
      {models.error ? <p role="alert" style={{ color: 'var(--color-destructive)' }}>模型列表读不到：测试窗口可能没开或已过期。</p> : null}
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>评审席位（模型和显示名分开保存，换模型不会改名字）</legend>
        {SEAT_CODES.map((seat, index) => (
          <div key={seat} className="space-y-1.5 rounded-md border p-3" style={{ borderColor: 'var(--border-primary)' }}>
            <Label htmlFor={`fusion-seat-${seat}`}>评审 {seat} 的显示名</Label>
            {nameInput(`fusion-seat-${seat}`, review.displayNames.reviewers[index] ?? '', name => set({ displayNames: { ...review.displayNames,
              reviewers: review.displayNames.reviewers.map((item, at) => (at === index ? name : item)) } }))}
            <Label htmlFor={`fusion-model-${seat}`}>模型</Label>
            {modelSelect(`fusion-model-${seat}`, review.reviewerModelIds[index] ?? '', id => set({
              reviewerModelIds: review.reviewerModelIds.map((item, at) => (at === index ? id : item)) }), reviewers)}
            <Label htmlFor={`fusion-role-${seat}`}>视角（跟着模型走）</Label>
            <select id={`fusion-role-${seat}`} className={selectClass} style={selectStyle} disabled={!review.reviewerModelIds[index]}
              value={review.reviewerRoles[review.reviewerModelIds[index] ?? ''] ?? ''} onChange={event => {
                const id = review.reviewerModelIds[index] ?? '';
                const rest = Object.fromEntries(Object.entries(review.reviewerRoles).filter(([key]) => key !== id));
                const role = event.target.value as (typeof ROLE_CODES)[number] | '';
                set({ reviewerRoles: role ? { ...rest, [id]: role } : rest });
              }}>
              <option value="">不指定</option>
              {ROLE_CODES.map(code => <option key={code} value={code}>{ROLE_LABELS[code]}</option>)}
            </select>
          </div>
        ))}
        <div className="space-y-1.5 rounded-md border p-3" style={{ borderColor: 'var(--border-primary)' }}>
          <Label htmlFor="fusion-seat-S">汇总的显示名</Label>
          {nameInput('fusion-seat-S', review.displayNames.summary, summary => set({ displayNames: { ...review.displayNames, summary } }))}
          <Label htmlFor="fusion-model-S">模型</Label>
          {modelSelect('fusion-model-S', review.summaryModelId ?? '', id => set({ summaryModelId: id || null }), summaries)}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="fusion-skill">评审 Skill（只列已发布的）</Label>
          <select id="fusion-skill" className={selectClass} style={selectStyle} value={review.skillId ?? ''}
            onChange={event => set({ skillId: event.target.value || null })}>
            <option value="">未选择</option>
            {published.map(skill => <option key={skill.id} value={skill.id}>{skill.skill_key}（第 {skill.published_version} 版）</option>)}
            {review.skillId && !published.some(skill => skill.id === review.skillId)
              ? <option value={review.skillId}>{skills.data ? '当前 Skill 未发布或读不到' : '正在读取 Skill…'}</option> : null}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fusion-rounds">最多几轮</Label>
          <select id="fusion-rounds" className={selectClass} style={selectStyle} value={review.maxRounds}
            onChange={event => set({ maxRounds: Number(event.target.value) })}>
            <option value={1}>1 轮（不辩论）</option>
            <option value={2}>2 轮（意见不一时辩论一轮）</option>
          </select>
        </div>
        <NumberField id="fusion-opinion" label={`每位评审的意见长度（${TOKEN_LIMITS.opinion.min}–${TOKEN_LIMITS.opinion.max} token，含思考）`}
          value={review.opinionOutputTokens} onChange={opinionOutputTokens => set({ opinionOutputTokens })} />
        <NumberField id="fusion-summary" label={`汇总的输出长度（${TOKEN_LIMITS.summary.min}–${TOKEN_LIMITS.summary.max} token）`}
          value={review.summaryOutputTokens} onChange={summaryOutputTokens => set({ summaryOutputTokens })} />
        <NumberField id="fusion-price" label={`每次评审的价格（积分，${PRICE_LIMITS.min}–${PRICE_LIMITS.max}）`}
          value={review.fixedPriceCredits} onChange={fixedPriceCredits => set({ fixedPriceCredits })} />
        <p className="text-xs" style={muted}>用户开始前看到的就是这个数。生成修订稿才扣，没有生成修订稿全额退回；模型实际成本超出的部分由平台承担。</p>
        <div className="space-y-1.5">
          <Label htmlFor="fusion-budget">单次评审平台成本保护线（美元）</Label>
          <Input id="fusion-budget" inputMode="decimal" placeholder="例如 5" value={review.maxBudgetUsd ?? ''}
            onChange={event => set({ maxBudgetUsd: event.target.value })} />
          <p className="text-xs" style={muted}>按模型报价估出的最坏成本超过这个数时，先去掉第 2 轮辩论；1 轮也超过就不开始。和用户付多少积分无关。</p>
        </div>
      </div>
      {problems.length ? <ul role="alert" className="list-disc pl-5 text-sm" style={{ color: 'var(--color-destructive)' }}>
        {problems.map(problem => <li key={problem}>{problem}</li>)}</ul> : null}
      {notice ? <p role={notice.tone === 'error' ? 'alert' : 'status'} className="text-sm"
        style={{ color: notice.tone === 'error' ? 'var(--color-destructive)' : 'var(--text-secondary)' }}>{notice.text}</p> : null}
      <Button onClick={() => void save()} disabled={!dirty || problems.length > 0 || update.isPending}>
        {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}保存评审团设置
      </Button>
    </SettingsCard>
  );
}

function NumberField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" inputMode="numeric" value={Number.isFinite(value) ? value : ''}
        onChange={event => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))} />
    </div>
  );
}
