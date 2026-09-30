/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Gauge, Loader2, Save } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TabsContent, TabsTrigger } from '@/components/ui/tabs';
import AdminErrorState from './AdminErrorState';
import {
  BUDGET_PURPOSES, FIELD_LABELS, PURPOSE_TITLES,
  budgetErrorMessage, describeLegacy, draftProblems, fieldProblem, fieldRange, fieldUnit, fieldsOf, toBudgetDraft, toBudgetInput,
  type BudgetDraft, type BudgetField, type BudgetPurpose, type BudgetView,
} from './mentorBudgetDraft';

export const MENTOR_BUDGET_TAB = 'mentor-budget';
const SUMMARY_LIMIT_TEST_ID = 'admin-setting-v3_summary_max_tokens';
const EFFECT_NOTE = '只影响之后新发起的对话，进行中的不受影响。';
const PURPOSE_NOTES: Record<BudgetPurpose, string> = {
  interactive: '导师和日常对话的每一轮。',
  organize: '步骤成果整理（含附属整理）。回答上限不在这里设置。',
  report: '报告生成尚未启用，此项预留；保存后暂时不会被任何调用使用。',
};
const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };
const noteStyle = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' };

export function MentorBudgetTabTrigger() {
  return (
    <TabsTrigger
      value={MENTOR_BUDGET_TAB}
      data-testid="admin-settings-mentor-budget-tab"
      className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
    >
      <Gauge className="h-4 w-4" />
      导师预算
    </TabsTrigger>
  );
}

/** Switches to the features tab, then focuses the summary output limit once it is mounted. */
export function MentorBudgetTabContent({ onOpenFeatures }: { onOpenFeatures: () => void }) {
  const openSummaryLimit = () => {
    onOpenFeatures();
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-testid="${SUMMARY_LIMIT_TEST_ID}"]`)?.focus();
    }, 0);
  };
  return (
    <TabsContent value={MENTOR_BUDGET_TAB}>
      <MentorBudgetSettings onOpenSummaryLimit={openSummaryLimit} />
    </TabsContent>
  );
}

export function MentorBudgetSettings({ onOpenSummaryLimit }: { onOpenSummaryLimit: () => void }) {
  const utils = trpc.useUtils();
  // Always re-read on mount: the summary output limit may have just been saved on another tab.
  const view = trpc.mentorBudget.get.useQuery(undefined, { refetchOnMount: 'always' });
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const [saved, setSaved] = useState(false);
  const save = trpc.mentorBudget.update.useMutation({
    onSuccess: async data => {
      utils.mentorBudget.get.setData(undefined, data);
      await utils.mentorBudget.get.invalidate();
      setDraft(null);
      setSaved(true);
    },
  });

  if (view.error && !view.data) {
    return <AdminErrorState error={{ message: budgetErrorMessage(view.error, '无法读取导师预算，请稍后重试') }}
      onRetry={() => { void view.refetch(); }} />;
  }
  if (!view.data) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <Loader2 className="h-4 w-4 animate-spin" />读取中
      </div>
    );
  }
  const current = draft ?? toBudgetDraft(view.data);
  return (
    <MentorBudgetPanel
      view={view.data}
      draft={current}
      onChange={(purpose, field, value) => {
        setSaved(false);
        if (save.error) save.reset();
        setDraft({ ...current, [purpose]: { ...current[purpose], [field]: value } });
      }}
      onSave={() => save.mutate(toBudgetInput(current))}
      saving={save.isPending}
      saveError={save.error ? budgetErrorMessage(save.error, '无法保存导师预算，请稍后重试') : null}
      saved={saved}
      onOpenSummaryLimit={onOpenSummaryLimit}
    />
  );
}

type PanelProps = {
  view: BudgetView;
  draft: BudgetDraft;
  onChange: (purpose: BudgetPurpose, field: BudgetField, value: string) => void;
  onSave: () => void;
  saving: boolean;
  saveError: string | null;
  saved: boolean;
  onOpenSummaryLimit: () => void;
};

export function MentorBudgetPanel(props: PanelProps) {
  const { view, draft, saving, saveError, saved } = props;
  const problems = draftProblems(view, draft);
  return (
    <Card data-testid="admin-settings-mentor-budget-section" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          导师预算
          <SourceBadge source={view.source} />
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-tertiary)' }}>
          按用途限制每次模型调用的输入大小、回答长度和带入的历史条数。
          输入按字节计，回答按 token 计（token 不等于字数）。
          本页单独保存，右上角“保存所有设置”不会保存这里的内容。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SourceNote view={view} />
        {BUDGET_PURPOSES.map(purpose => (
          <PurposeGroup key={purpose} purpose={purpose} {...props} />
        ))}
        <div className="space-y-3 border-t pt-4" style={{ borderColor: 'var(--border-primary)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{EFFECT_NOTE}最终是否有效以服务端校验为准。</p>
          {problems.length > 0 && (
            <p className="text-sm" data-testid="mentor-budget-draft-problem" style={{ color: 'var(--warning)' }}>
              还不能保存：{problems.length} 项需要修改，见上方各输入框下的提示。
            </p>
          )}
          {saveError && <p role="alert" className="text-sm text-rose-400" data-testid="mentor-budget-save-error">{saveError}</p>}
          {saved && !saveError && (
            <p role="status" className="text-sm" data-testid="mentor-budget-saved" style={{ color: 'var(--success)' }}>
              已保存，并已重新读取服务端的配置。{EFFECT_NOTE}
            </p>
          )}
          <Button
            data-testid="mentor-budget-save"
            onClick={props.onSave}
            disabled={saving || problems.length > 0}
            className="w-full gap-2 bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90 sm:w-auto"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? '保存中...' : '保存导师预算'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceBadge({ source }: { source: BudgetView['source'] }) {
  return (
    <Badge variant="outline" data-testid="mentor-budget-source" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
      {source === 'configured' ? '已配置' : '沿用默认'}
    </Badge>
  );
}

function SourceNote({ view }: { view: BudgetView }) {
  if (view.source === 'configured') {
    return (
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        当前使用下方已保存的配置。修改后需要三项用途一起保存。
      </p>
    );
  }
  return (
    <div className="rounded-lg p-4 text-sm" data-testid="mentor-budget-legacy" style={noteStyle}>
      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>还没有保存过配置，目前沿用默认行为：</p>
      <ul className="mt-2 list-disc space-y-1 pl-5" style={{ color: 'var(--text-secondary)' }}>
        {describeLegacy(view).map(line => <li key={line}>{line}</li>)}
      </ul>
      <p className="mt-2" style={{ color: 'var(--warning)' }}>
        第一次保存后，三项用途都改为按这里填写的数值执行（交互回答上限不再按上面的默认规则取值），
        本页不能再切回“沿用默认”。
      </p>
    </div>
  );
}

function PurposeGroup({ purpose, view, draft, onChange, onOpenSummaryLimit }: PanelProps & { purpose: BudgetPurpose }) {
  return (
    <section className="space-y-3" data-testid={`mentor-budget-${purpose}`}>
      <div>
        <h3 className="text-base font-medium" style={{ color: 'var(--text-primary)' }}>{PURPOSE_TITLES[purpose]}</h3>
        <p className="text-sm" style={{ color: purpose === 'report' ? 'var(--warning)' : 'var(--text-tertiary)' }}>
          {PURPOSE_NOTES[purpose]}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {fieldsOf(purpose).map(field => (
          <BudgetInputField key={field} purpose={purpose} field={field} view={view} draft={draft} onChange={onChange} />
        ))}
        {purpose === 'organize' && <OrganizeOutput view={view} onOpenSummaryLimit={onOpenSummaryLimit} />}
      </div>
    </section>
  );
}

function BudgetInputField({ purpose, field, view, draft, onChange }: {
  purpose: BudgetPurpose; field: BudgetField; view: BudgetView; draft: BudgetDraft;
  onChange: PanelProps['onChange'];
}) {
  const id = `mentor-budget-${purpose}-${field}`;
  const [min, max] = fieldRange(view, purpose, field);
  const unit = fieldUnit(field);
  const value = (draft[purpose] as Partial<Record<BudgetField, string>>)[field] ?? '';
  const problem = fieldProblem(view, draft, purpose, field);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} style={{ color: 'var(--text-secondary)' }}>{FIELD_LABELS[field]}</Label>
      <Input
        id={id}
        data-testid={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        placeholder="未设置"
        aria-invalid={problem ? true : undefined}
        onChange={event => onChange(purpose, field, event.target.value)}
        className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
      />
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        系统上限 {max} {unit}（可填 {min}–{max}）
      </p>
      {problem && <p className="text-xs" data-testid={`${id}-problem`} style={{ color: 'var(--warning)' }}>{problem}</p>}
    </div>
  );
}

function OrganizeOutput({ view, onOpenSummaryLimit }: { view: BudgetView; onOpenSummaryLimit: () => void }) {
  return (
    <div className="space-y-1" data-testid="mentor-budget-organize-output">
      <Label style={{ color: 'var(--text-secondary)' }}>回答上限（token，只读）</Label>
      <p className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
        {view.organizeOutput.maxOutputTokens} token
      </p>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        来自“整理模型回复长度（v3_summary_max_tokens）”，在功能设置里修改。
      </p>
      <button
        type="button"
        data-testid="mentor-budget-open-summary-limit"
        onClick={onOpenSummaryLimit}
        className="text-xs underline hover:no-underline"
        style={{ color: 'var(--color-primary)' }}
      >
        前往修改整理模型回复长度 →
      </button>
    </div>
  );
}
