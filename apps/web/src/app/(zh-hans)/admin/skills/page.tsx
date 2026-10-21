/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
'use client';

import { useState } from 'react';
import type { AdminSkill } from '@repo/api';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

const statusLabels = { draft: '草稿', published: '已发布', archived: '已归档' };

export function SkillStatus({ skill }: { skill: AdminSkill }) {
  return <div className="space-y-1 text-sm">
    <Badge variant="outline">{statusLabels[skill.status]}</Badge>
    <span className="ml-2">版本 {skill.published_version}</span>
    <p className="break-all text-xs text-muted-foreground">SHA-256：{skill.published_content_hash ?? '尚未发布'}</p>
  </div>;
}

function SkillEditor({ skill, busy, onSave, onPublish, onArchive }: {
  skill: AdminSkill;
  busy: boolean;
  onSave: (content: string) => Promise<void>;
  onPublish: () => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(skill.draft_content);
  const dirty = draft !== skill.draft_content;
  return <Card>
    <CardHeader><CardTitle>{skill.skill_key}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <SkillStatus skill={skill} />
      <Label htmlFor="skill-draft">草稿内容</Label>
      <Textarea id="skill-draft" value={draft} onChange={(event) => setDraft(event.target.value)} rows={12} maxLength={100000} disabled={busy} />
      <p className="text-sm text-muted-foreground">保存草稿不会替换已发布内容。发布后，新请求使用新版本；已经开始的请求继续使用原版本。</p>
      {dirty && <p role="status" className="text-sm">草稿有未保存修改，请先保存再发布。</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !dirty} onClick={() => void onSave(draft)}>保存草稿</Button>
        <Button disabled={busy || dirty || !draft.trim()} onClick={() => void onPublish()}>发布新版本</Button>
        <Button variant="outline" disabled={busy || skill.status === 'archived'} onClick={() => {
          if (window.confirm('归档后，绑定此 Skill 的模块将无法发起新请求。确认归档？')) void onArchive();
        }}>归档</Button>
      </div>
    </CardContent>
  </Card>;
}

export default function AdminSkillsPage() {
  const [offset, setOffset] = useState(0);
  const [moduleOffset, setModuleOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [skillKey, setSkillKey] = useState('');
  const [moduleTitle, setModuleTitle] = useState('');
  const [moduleDescription, setModuleDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const utils = trpc.useUtils();
  const skills = trpc.skills.list.useQuery({ offset });
  const modules = trpc.skills.listModules.useQuery({ offset: moduleOffset });
  const detail = trpc.skills.get.useQuery({ id: selected ?? '' }, { enabled: selected !== null });
  const create = trpc.skills.create.useMutation();
  const edit = trpc.skills.editDraft.useMutation();
  const publish = trpc.skills.publish.useMutation();
  const archive = trpc.skills.archive.useMutation();
  const createModule = trpc.skills.createModule.useMutation();
  const bind = trpc.skills.bindModule.useMutation();
  const activate = trpc.skills.setModuleActive.useMutation();

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setFailure(''); setNotice('');
    try {
      await action();
      await utils.skills.invalidate();
      setNotice(message);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '操作失败，请重试');
    } finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-6xl space-y-6 p-6">
    <div><h1 className="text-2xl font-semibold">Skill 管理</h1><p className="mt-2 text-muted-foreground">管理发布内容与模块绑定。只有绑定可用已发布 Skill 的模块才能启用。</p></div>
    {notice && <p role="status">{notice}</p>}
    {(failure || skills.error || modules.error || detail.error) && <div role="alert" className="rounded-lg border border-destructive p-4">
      {failure || skills.error?.message || modules.error?.message || detail.error?.message}
      <Button variant="outline" className="ml-3" onClick={() => void utils.skills.invalidate()}>重新加载</Button>
    </div>}
    <div className="grid gap-6 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Skills</CardTitle></CardHeader><CardContent className="space-y-4">
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const result = await create.mutateAsync({ skillKey, draftContent: '' });
          setSelected(result.id); setSkillKey('');
        }, '已创建草稿'); }}>
          <Label htmlFor="skill-key">新 Skill 标识（小写字母、数字、下划线或连字符；创建后不可改）</Label>
          <Input id="skill-key" value={skillKey} onChange={(event) => setSkillKey(event.target.value)} required maxLength={100} pattern="[a-z0-9][a-z0-9_-]*" disabled={busy} />
          <Button disabled={busy}>新建 Skill</Button>
        </form>
        {skills.isLoading && <p role="status">正在加载 Skills…</p>}
        {skills.data?.skills.length === 0 && <p>暂无 Skill，请先创建草稿。</p>}
        {skills.data?.skills.map((skill) => <div key={skill.id} className="space-y-2 border-t pt-3">
          <Button variant={selected === skill.id ? 'secondary' : 'ghost'} disabled={busy} onClick={() => setSelected(skill.id)}>{skill.skill_key}</Button>
          <SkillStatus skill={skill} />
        </div>)}
        <div className="flex gap-2"><Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(offset - 50)}>上一页 Skills</Button><Button variant="outline" disabled={busy || !skills.data || offset + 50 >= skills.data.total} onClick={() => setOffset(offset + 50)}>下一页 Skills</Button></div>
      </CardContent></Card>
      <div>{detail.data && !detail.error ? <SkillEditor key={`${detail.data.id}:${detail.data.draft_content}`} skill={detail.data} busy={busy}
        onSave={(draftContent) => run(() => edit.mutateAsync({ id: detail.data.id, draftContent }), '草稿已保存')}
        onPublish={() => run(() => publish.mutateAsync({ id: detail.data.id }), '已发布新版本')}
        onArchive={() => run(() => archive.mutateAsync({ id: detail.data.id }), 'Skill 已归档')} />
        : <p className="p-6 text-muted-foreground">{detail.isFetching ? '正在加载草稿…' : '选择一个 Skill 编辑或发布。'}</p>}</div>
    </div>
    <Card><CardHeader><CardTitle>模块与绑定</CardTitle></CardHeader><CardContent className="space-y-4">
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await createModule.mutateAsync({ title: moduleTitle, description: moduleDescription }); setModuleTitle(''); setModuleDescription('');
      }, '模块已创建，默认停用'); }}>
        <Label htmlFor="module-title">模块名称</Label><Input id="module-title" value={moduleTitle} onChange={(event) => setModuleTitle(event.target.value)} required maxLength={100} disabled={busy} />
        <Label htmlFor="module-description">公开简介（不作为 AI 提示词）</Label><Input id="module-description" value={moduleDescription} onChange={(event) => setModuleDescription(event.target.value)} maxLength={1000} disabled={busy} />
        <Button disabled={busy}>新建停用模块</Button>
      </form>
      <p className="text-sm text-muted-foreground">先在上方选择 Skill，再绑定停用模块。启用前须发布 Skill；更换绑定前须停用。</p>
      {modules.isLoading && <p role="status">正在加载模块…</p>}
      {modules.data?.modules.length === 0 && <p>暂无模块。</p>}
      {modules.data?.modules.map((module) => <div key={module.id} className="space-y-2 border-t pt-4">
        <h3 className="font-medium">{module.title} <Badge variant="outline">{module.active ? '已启用' : '已停用'}</Badge></h3>
        <p className="break-all text-sm">绑定：{module.skill_id ?? '未绑定'}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || module.active || !detail.data || !!detail.error} onClick={() => void run(() => bind.mutateAsync({ id: module.id, skillId: detail.data!.id }), '绑定已更新')}>绑定 {detail.data?.skill_key ?? '当前 Skill'}</Button>
          <Button variant="outline" disabled={busy || module.active || !module.skill_id} onClick={() => void run(() => bind.mutateAsync({ id: module.id, skillId: null }), '已解除绑定')}>解除绑定</Button>
          <Button disabled={busy || (!module.active && !module.skill_id)} onClick={() => void run(() => activate.mutateAsync({ id: module.id, active: !module.active }), module.active ? '模块已停用' : '模块已启用')}>{module.active ? '停用' : '启用'}</Button>
        </div>
      </div>)}
      <div className="flex gap-2"><Button variant="outline" disabled={busy || moduleOffset === 0} onClick={() => setModuleOffset(moduleOffset - 50)}>上一页模块</Button><Button variant="outline" disabled={busy || !modules.data || moduleOffset + 50 >= modules.data.total} onClick={() => setModuleOffset(moduleOffset + 50)}>下一页模块</Button></div>
    </CardContent></Card>
  </div>;
}
