/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export type SkillForm = {
  kind: 'document' | 'social'; directoryName: string; files: { path: string; base64: string }[];
  steps: { title: string; resources: string[] }[]; reviewed: boolean;
};
export const emptySkillForm = (): SkillForm => ({ kind: 'document', directoryName: '', files: [],
  steps: [{ title: '', resources: ['SKILL.md'] }], reviewed: false });

/** Only reads selected files. Never executes a package, follows links, or uploads on selection. */
export async function readSkillFiles(files: FileList | File[]) {
  const selected = Array.from(files);
  if (!selected.length || selected.length > 64 || selected.reduce((n,f) => n + f.size, 0) > 2 * 1024 * 1024)
    throw new Error('请选择 1–64 个文件，总大小不超过 2 MB。');
  const roots = new Set(selected.filter(f => f.webkitRelativePath).map(f => f.webkitRelativePath.split('/')[0]));
  if (roots.size > 1) throw new Error('一次只能导入一个 Skill 文件夹。');
  const result = [];
  for (const file of selected) {
    const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    if (!(/\.(md|ya?ml)$/.test(path)) || /(^|\/)scripts\//.test(path))
      throw new Error(`目前仅支持 Markdown 和 YAML 文本文件。请先移除不受支持的文件：${path}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('文件必须使用 UTF-8 编码。'); }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    result.push({ path, base64: btoa(binary) });
  }
  if (!result.some(f => f.path === 'SKILL.md')) throw new Error('所选文件夹需要包含 SKILL.md。');
  return { directoryName: [...roots][0] ?? '', files: result };
}

export function ModuleSkillEditor({ value, onChange, error, onError, disabled = false }: {
  value: SkillForm; onChange: (next: SkillForm) => void; error: string; onError: (message: string) => void; disabled?: boolean;
}) {
  const [reading, setReading] = useState(false);
  const patch = (next: Partial<SkillForm>) => onChange({ ...value, ...next, reviewed: false });
  const load = async (files: FileList | null) => {
    if (!files) return;
    setReading(true);
    try {
      const result = await readSkillFiles(files);
      patch({ ...result, directoryName: result.directoryName || value.directoryName,
        steps: value.steps.map(step => ({ ...step, resources: step.resources.filter(p => result.files.some(f => f.path === p)) })) });
      onError('');
    } catch (e) { onError(e instanceof Error ? e.message : '读取文件失败'); } finally { setReading(false); }
  };
  return <fieldset disabled={disabled || reading} className="space-y-4 rounded-lg border border-[var(--border-primary)] p-4">
    <legend className="px-2 font-medium">Skill 文件与步骤</legend>
    {reading && <p role="status">正在读取 Skill 文件…</p>}
    <p className="text-sm text-[var(--text-secondary)]">导入解压后的 Skill 文件夹，支持 SKILL.md、Markdown 参考文件和只读 YAML 模板。文件只对管理员和运行时开放。</p>
    <label className="block text-sm">使用方式
      <select aria-label="Skill 使用方式" value={value.kind} onChange={e => patch({ kind: e.target.value as SkillForm['kind'] })} className="ml-2 bg-[var(--bg-tertiary)] p-2 rounded">
        <option value="document">通用分步成果</option><option value="social">社媒账号规划</option>
      </select>
    </label>
    {value.kind === 'social' && <p className="text-sm">社媒规划保留同账号一个项目的规则。使用者需要已有的账号授权；导入文件不会自动授权任何账号。</p>}
    <label className="block text-sm">导入文件夹
      <input aria-label="导入 Skill 文件夹" type="file" multiple {...{ webkitdirectory: '' }}
        onChange={e => void load(e.target.files)} className="mt-2 block w-full" />
    </label>
    <label className="block text-sm">或导入单个 SKILL.md
      <input aria-label="导入单个 SKILL.md" type="file" accept=".md" onChange={e => void load(e.target.files)} className="mt-2 block w-full" />
    </label>
    <label className="block text-sm">Skill 名称（与文件开头的 name 一致）
      <Input aria-label="Skill 名称" value={value.directoryName} onChange={e => patch({ directoryName: e.target.value })} placeholder="如：social-media-commercial-strategist" />
    </label>
    {value.files.length > 0 && <details><summary>已载入 {value.files.length} 个文件</summary><ul className="text-xs break-all">{value.files.map(f => <li key={f.path}>{f.path}</li>)}</ul></details>}
    <p className="text-sm text-[var(--text-secondary)]">按顺序设置步骤。每一步都会读取 SKILL.md；其他参考文件请按需要勾选。用户确认后才进入下一步。</p>
    {value.steps.map((step, i) => <div key={i} className="space-y-2 rounded border border-[var(--border-primary)] p-3">
      <div className="flex gap-2 items-center"><span>{i + 1}.</span>
        <Input aria-label={`步骤 ${i + 1} 名称`} value={step.title} onChange={e => patch({ steps: value.steps.map((s,j) => j === i ? { ...s, title: e.target.value } : s) })} />
        <Button type="button" variant="outline" disabled={value.steps.length === 1} onClick={() => patch({ steps: value.steps.filter((_,j) => j !== i) })}>删除</Button>
      </div>
      <details><summary className="text-sm">本步参考文件（{step.resources.length}）</summary>
        {value.files.map(f => <label key={f.path} className="flex gap-2 text-sm py-1 break-all">
          <input type="checkbox" checked={step.resources.includes(f.path)} onChange={e => patch({ steps: value.steps.map((s,j) => j === i ? { ...s, resources: e.target.checked ? [...s.resources,f.path] : s.resources.filter(p => p !== f.path) } : s) })} />{f.path}
        </label>)}
      </details>
    </div>)}
    <Button type="button" variant="outline" disabled={value.steps.length >= 32} onClick={() => patch({ steps: [...value.steps, { title: '', resources: ['SKILL.md'] }] })}>添加步骤</Button>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.reviewed} onChange={e => onChange({ ...value, reviewed: e.target.checked })} />我已检查步骤顺序和各步使用的参考文件</label>
    <p className="text-xs text-[var(--text-secondary)]">对话模型使用上方指定模型；整理成果使用 AI 模型页单独配置的汇总模型。</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </fieldset>;
}
