'use client';

import { useEffect, useState } from 'react';
import { Brain, Loader2, RefreshCw } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  PURPOSE_LABELS,
  REASONING_PURPOSES,
  allowedModes,
  allowedWires,
  routeSupports,
  type CatalogSnapshot,
  type PurposeSetting,
  type PurposeSettings,
  type ReasoningPurpose,
} from '@repo/api/src/shared/modelReasoning';

type Wire = 'reasoning_effort' | 'reasoning';
/** One purpose's form state; `unset` stores nothing for that purpose. */
type Draft = { mode: 'unset' | PurposeSetting['mode']; effort: string; wire: Wire; budget: string };

const PURPOSE_NOTES: Record<ReasoningPurpose, string> = {
  interactive: '导师和日常对话。必须设置，没设置的模型不能用作 Skill 模型。',
  organize: '步骤成果整理。未设置 = 用供应商默认（不发送思考设置）。',
  review: '暂未接入任何调用，只保存设置。',
  writing: '暂未接入任何调用，只保存设置。',
};
const MODE_LABELS: Record<Draft['mode'], string> = {
  unset: '未设置',
  provider_default: '用供应商默认（不发送思考设置）',
  off: '关闭思考',
  effort: '指定档位',
  budget: '思考预算（token）',
};

function toDraft(setting: PurposeSetting | undefined, defaultWire: Wire): Draft {
  if (!setting) return { mode: 'unset', effort: '', wire: defaultWire, budget: '' };
  return {
    mode: setting.mode,
    effort: setting.mode === 'effort' ? setting.effort : '',
    wire: setting.mode === 'off' || setting.mode === 'effort' ? setting.wire : defaultWire,
    budget: setting.mode === 'budget' ? String(setting.maxTokens) : '',
  };
}
function fromDraft(draft: Draft): PurposeSetting | undefined {
  switch (draft.mode) {
    case 'unset':
      return undefined;
    case 'provider_default':
      return { mode: 'provider_default' };
    case 'off':
      return { mode: 'off', wire: draft.wire };
    case 'effort':
      return { mode: 'effort', effort: draft.effort as Extract<PurposeSetting, { mode: 'effort' }>['effort'], wire: draft.wire };
    case 'budget':
      return { mode: 'budget', maxTokens: Number(draft.budget) };
  }
}
/** Parameter forms the chosen route supports (plus the current one, so it stays visible). */
function wiresFor(catalog: CatalogSnapshot | null, route: string | null, current: Wire): Wire[] {
  const wires = allowedWires(catalog, route);
  return wires.includes(current) ? wires : [...wires, current];
}
/** Modes the catalog and route allow, so the menu never offers a choice the server
 * will refuse; the current mode stays listed so a stored setting remains visible. */
function modesFor(catalog: CatalogSnapshot | null, route: string | null, current: Draft['mode']): Draft['mode'][] {
  const modes: Draft['mode'][] = ['unset', ...allowedModes(catalog, route)];
  return modes.includes(current) ? modes : [...modes, current];
}
type TryOutcome = {
  ok: boolean; httpStatus: number | null; firstTextMs: number | null; totalMs: number; hasText: boolean; truncated: boolean;
  reasoningTokens: number | null; costUsd: number | null; maxTokens: number; error: string | null; providerMessage: string | null;
};
/** Measurements only; the reply text never reaches the page. */
function describeTry(result: TryOutcome): string {
  if (!result.ok) {
    const status = result.httpStatus ? `，HTTP ${result.httpStatus}` : '';
    return `调用失败（${result.error ?? '未知'}${status}）${result.providerMessage ? `：${result.providerMessage}` : ''}`;
  }
  const parts = [
    `首字 ${result.firstTextMs === null ? '无' : `${result.firstTextMs} ms`}`,
    `总耗时 ${result.totalMs} ms`,
    result.hasText ? '有正文' : '没有正文',
    `思考 token ${result.reasoningTokens ?? '未报告'}`,
    `费用 ${result.costUsd === null ? '未报告' : `$${result.costUsd}`}`,
  ];
  if (result.truncated) parts.push(`被输出上限（${result.maxTokens}）截断，思考可能用完了额度`);
  return parts.join('；');
}

/** A choice the form cannot save yet, before asking the server. */
function draftProblem(drafts: Record<ReasoningPurpose, Draft>): string | null {
  for (const purpose of REASONING_PURPOSES) {
    const draft = drafts[purpose];
    if (draft.mode === 'effort' && !draft.effort) return `"${PURPOSE_LABELS[purpose]}"请选择档位`;
    if (draft.mode === 'budget' && !(Number.isSafeInteger(Number(draft.budget)) && Number(draft.budget) > 0))
      return `"${PURPOSE_LABELS[purpose]}"的思考预算要填正整数`;
  }
  return null;
}
function supports(catalog: CatalogSnapshot | null, route: string | null, parameter: string) {
  return routeSupports(catalog, route, parameter);
}

/** Per-row entry to the reasoning settings of one model (MODEL-REASONING). */
export function ModelReasoningButton({ modelId, name }: { modelId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="思考设置"
        title="思考设置"
        data-testid={`admin-model-reasoning-${modelId}`}
        onClick={() => setOpen(true)}
        className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
      >
        <Brain className="h-4 w-4" />
      </Button>
      {open ? <ModelReasoningDialog modelId={modelId} name={name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ModelReasoningDialog({ modelId, name, onClose }: { modelId: string; name: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const view = trpc.modelReasoning.get.useQuery({ modelId });
  const refresh = trpc.modelReasoning.refreshCatalog.useMutation({ onSuccess: data => utils.modelReasoning.get.setData({ modelId }, data) });
  const save = trpc.modelReasoning.save.useMutation({
    onSuccess: data => {
      utils.modelReasoning.get.setData({ modelId }, data);
      void utils.settings.getSummaryModels.invalidate();
    },
  });
  const tryOnce = trpc.modelReasoning.tryOnce.useMutation();
  const [tried, setTried] = useState<{ purpose: ReasoningPurpose; text: string; failed: boolean } | null>(null);
  const runTry = (purpose: ReasoningPurpose) => {
    setTried(null);
    tryOnce.mutate({ modelId, purpose }, {
      onSuccess: result => setTried({ purpose, failed: !result.ok, text: describeTry(result) }),
      onError: error => setTried({ purpose, failed: true, text: error.message }),
    });
  };
  const catalog = view.data?.config.catalog ?? null;
  const [route, setRoute] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<ReasoningPurpose, Draft> | null>(null);

  useEffect(() => {
    if (!view.data || drafts) return;
    const stored = view.data.config;
    const wire: Wire = supports(stored.catalog, stored.route, 'reasoning_effort') ? 'reasoning_effort' : 'reasoning';
    setRoute(stored.route);
    setDrafts(Object.fromEntries(REASONING_PURPOSES.map(purpose => [purpose, toDraft(stored.purposes[purpose], wire)])) as Record<ReasoningPurpose, Draft>);
  }, [view.data, drafts]);

  const update = (purpose: ReasoningPurpose, patch: Partial<Draft>) =>
    setDrafts(old => (old ? { ...old, [purpose]: { ...old[purpose], ...patch } } : old));
  const submit = () => {
    if (!drafts) return;
    const purposes: PurposeSettings = {};
    for (const purpose of REASONING_PURPOSES) {
      const setting = fromDraft(drafts[purpose]);
      if (setting) purposes[purpose] = setting;
    }
    save.mutate({ modelId, route, purposes });
  };
  const reasoning = catalog?.reasoning ?? null;
  const problem = drafts ? draftProblem(drafts) : null;
  const serverIssues = view.data?.issues ?? [];

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>思考设置 · {name}</DialogTitle>
          <DialogDescription>
            按用途设置调用这个模型时的思考方式。可选项来自 OpenRouter 公开目录；保存前会按所选线路检查。
          </DialogDescription>
        </DialogHeader>
        {view.isLoading || !drafts ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" />读取中</div>
        ) : (
          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>OpenRouter 目录</Label>
                <Button variant="outline" size="sm" onClick={() => refresh.mutate({ modelId })} disabled={refresh.isPending}>
                  {refresh.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  {catalog ? '重新读取' : '读取目录'}
                </Button>
              </div>
              {catalog ? (
                <p className="text-[var(--text-secondary)]">
                  读取时间 {new Date(catalog.fetchedAt).toLocaleString()}。
                  {reasoning
                    ? `可关闭思考：${reasoning.mandatory ? '否' : '是'}；档位：${reasoning.supportedEfforts.join(' / ') || '目录未列出'}；` +
                      `默认档位：${reasoning.defaultEffort ?? '未列出'}；支持思考预算：${reasoning.supportsMaxTokens ? '是' : '否'}。`
                    : '目录没有列出这个模型的思考设置，只能选"用供应商默认"。'}
                </p>
              ) : (
                <p className="text-[var(--text-secondary)]">还没有读取目录。</p>
              )}
              {refresh.error ? <p role="alert" className="text-rose-400">{refresh.error.message}</p> : null}
            </section>

            <section className="space-y-2">
              <Label>供应商线路</Label>
              <Select value={route ?? ''} onValueChange={value => setRoute(value || null)} disabled={!catalog}>
                <SelectTrigger aria-label="供应商线路"><SelectValue placeholder="选择线路" /></SelectTrigger>
                <SelectContent>
                  {(catalog?.endpoints ?? []).map(endpoint => (
                    <SelectItem key={endpoint.tag} value={endpoint.tag}>
                      {endpoint.providerName}（{endpoint.tag}）
                      {` · 工具${endpoint.supportedParameters.includes('tools') ? '✓' : '✗'}`}
                      {` · reasoning_effort${endpoint.supportedParameters.includes('reasoning_effort') ? '✓' : '✗'}`}
                      {` · reasoning${endpoint.supportedParameters.includes('reasoning') ? '✓' : '✗'}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-tertiary)]">
                测试窗口或正式报价必须使用同一条线路。先选线路，才会列出这条线路支持的思考方式。
              </p>
            </section>

            {REASONING_PURPOSES.map(purpose => {
              const draft = drafts[purpose];
              return (
                <section key={purpose} className="space-y-2 rounded-md border border-[var(--border-primary)] p-3">
                  <div>
                    <Label>{PURPOSE_LABELS[purpose]}</Label>
                    <p className="text-xs text-[var(--text-tertiary)]">{PURPOSE_NOTES[purpose]}</p>
                  </div>
                  <Select value={draft.mode} onValueChange={value => update(purpose, { mode: value as Draft['mode'] })}>
                    <SelectTrigger aria-label={`${PURPOSE_LABELS[purpose]}的思考方式`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {modesFor(catalog, route, draft.mode).map(mode => (
                        <SelectItem key={mode} value={mode}>{MODE_LABELS[mode]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {draft.mode === 'effort' ? (
                    <Select value={draft.effort} onValueChange={value => update(purpose, { effort: value })}>
                      <SelectTrigger aria-label={`${PURPOSE_LABELS[purpose]}的档位`}><SelectValue placeholder="选择档位" /></SelectTrigger>
                      <SelectContent>
                        {(reasoning?.supportedEfforts ?? []).map(effort => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {draft.mode === 'off' || draft.mode === 'effort' ? (
                    <Select value={draft.wire} onValueChange={value => update(purpose, { wire: value as Wire })}>
                      <SelectTrigger aria-label={`${PURPOSE_LABELS[purpose]}的参数写法`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {wiresFor(catalog, route, draft.wire).map(wire => (
                          <SelectItem key={wire} value={wire}>{wire === 'reasoning' ? 'reasoning 对象' : 'reasoning_effort 参数'}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => runTry(purpose)} disabled={tryOnce.isPending}>
                      {tryOnce.isPending && tryOnce.variables?.purpose === purpose ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}试一次
                    </Button>
                    <span className="text-xs text-[var(--text-tertiary)]">用已保存的设置真实调用一次，费用由平台承担</span>
                  </div>
                  {tried?.purpose === purpose ? (
                    <p role="status" className={tried.failed ? 'text-rose-400' : 'text-emerald-400'}>{tried.text}</p>
                  ) : null}
                  {draft.mode === 'budget' ? (
                    <Input
                      type="number"
                      min={1}
                      aria-label={`${PURPOSE_LABELS[purpose]}的思考预算`}
                      value={draft.budget}
                      onChange={event => update(purpose, { budget: event.target.value })}
                    />
                  ) : null}
                </section>
              );
            })}

            {serverIssues.length ? (
              <ul role="status" className="list-disc space-y-1 pl-5 text-amber-400">
                {serverIssues.map(issue => <li key={`${issue.purpose}-${issue.code}`}>{issue.message}</li>)}
              </ul>
            ) : null}
            {problem ? <p role="status" className="text-amber-400">{problem}</p> : null}
            {save.error ? <p role="alert" className="text-rose-400">{save.error.message}</p> : null}
            {save.isSuccess ? <p role="status" className="text-emerald-400">已保存</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button onClick={submit} disabled={!drafts || Boolean(problem) || save.isPending || refresh.isPending}>
            {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
