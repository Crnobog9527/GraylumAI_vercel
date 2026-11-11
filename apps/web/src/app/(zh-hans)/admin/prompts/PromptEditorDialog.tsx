/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ModuleSkillEditor, ModuleSettings } from './module-skill-editor';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  platformConfig, iconOptions, categoryConfig,
  type ModuleCategory, type Platform, type ModuleForm,
} from './promptsShared';
import type { PromptsAdmin } from './usePromptsAdmin';

// 新建 / 编辑功能模块的弹窗（提示词或 Skill）。从 page.tsx 原样搬出。
export function PromptEditorDialog({ admin }: { admin: PromptsAdmin }) {
  const {
    refetch, dialogOpen, setDialogOpen, mode, setMode, editingModule, setEditingModule, formData, setFormData,
    skillModels, skillForm, setSkillForm, skillIdentity, skillError, setSkillError, skillLoading, skillReading,
    setSkillReading, currentEditorSession, editorSession, saveSkill, createPrompt, updatePrompt, closeDialog,
    handleSubmit, modelsData,
  } = admin;

  return (
    <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
      <DialogContent
        className="max-w-3xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>
            {editingModule ? '编辑功能模块' : '新建功能模块'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            编辑功能广场展示信息，配置提示词或带步骤的 Skill。
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={saveSkill.isPending || skillLoading || skillReading} className="space-y-4 py-4 max-h-[65vh] overflow-y-auto pr-1">
          <label className="block text-sm">功能类型
            <select aria-label="功能类型" value={mode} disabled={!!editingModule?.skill_id || saveSkill.isPending}
              onChange={e => setMode(e.target.value as 'prompt' | 'skill')} className="ml-3 rounded bg-[var(--bg-tertiary)] p-2">
              <option value="prompt">提示词对话</option><option value="skill">Skill 分步对话</option>
            </select>
          </label>
          {skillLoading && <p role="status">正在读取已发布 Skill…</p>}
          {editingModule?.skill_id && skillError && <a href="/admin/skills" className="text-sm underline">打开旧版文本 Skill 管理</a>}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>模块名称 *</Label>
              <Input
                data-testid="prompt-name-input"
                value={formData.title}
                onChange={(event) => setFormData({ ...formData, title: event.target.value })}
                placeholder="如：短视频脚本生成"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>分类</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value as ModuleCategory })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  {Object.entries(categoryConfig).map(([key, config]) => {
                    const IconComponent = config.icon;
                    return (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          <IconComponent className={`h-4 w-4 ${config.color.split(' ')[1]}`} />
                          {config.label}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>图标</Label>
              <Select value={formData.icon} onValueChange={(value) => setFormData({ ...formData, icon: value })}>
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  {iconOptions.map((icon) => (
                    <SelectItem key={icon} value={icon}>{icon}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>适用平台</Label>
              <Select
                value={formData.platform}
                onValueChange={(value) => setFormData({ ...formData, platform: value as Platform })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  {Object.entries(platformConfig).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>{mode === 'skill' ? '对话模型 *' : '指定模型'}</Label>
              <Select
                value={formData.modelId || 'none'}
                onValueChange={(value) => setFormData({ ...formData, modelId: value === 'none' ? '' : value })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue placeholder="不限制" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value="none">不限制</SelectItem>
                  {(mode === 'skill' ? skillModels.data ?? [] : modelsData)?.map((model) => (
                    <SelectItem key={model.id} value={model.id} disabled={'available' in model && !model.available}>
                      {model.name}{'reason' in model && model.reason ? `（${model.reason}）` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {mode === 'skill' && !skillLoading && <ModuleSkillEditor key={currentEditorSession} value={skillForm}
            onChange={value => { if (currentEditorSession === editorSession.current) setSkillForm(value); }}
            error={skillError} onError={message => { if (currentEditorSession === editorSession.current) setSkillError(message); }}
            onReadingChange={reading => {
              if (currentEditorSession !== editorSession.current) return;
              setSkillReading(reading);
              if (reading) setSkillForm(value => ({ ...value, reviewed: false }));
            }} disabled={saveSkill.isPending || skillLoading} isNew={!editingModule?.skill_id} />}
          {mode === 'skill' && <ModuleSettings editing={editingModule} setEditing={setEditingModule} refetch={refetch}
            hasReport={!!skillForm.reportGeneration} />}
          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>卡片描述</Label>
            <Input
              data-testid="prompt-description-input"
              value={formData.description}
              onChange={(event) => setFormData({ ...formData, description: event.target.value })}
              placeholder="一句话说明这个模块在功能广场里的用途"
              className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
            />
          </div>

          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>详细介绍</Label>
            <Textarea
              value={formData.fullDescription}
              onChange={(event) => setFormData({ ...formData, fullDescription: event.target.value })}
              placeholder="用于模块详情弹窗的长说明"
              rows={3}
              className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>展示图 URL</Label>
              <Input
                value={formData.imageUrl}
                onChange={(event) => setFormData({ ...formData, imageUrl: event.target.value })}
                placeholder="https://..."
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>积分展示文案</Label>
              <Input
                value={formData.creditsDisplay}
                onChange={(event) => setFormData({ ...formData, creditsDisplay: event.target.value })}
                placeholder="按实际 token 计费"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>徽标类型</Label>
              <Select
                value={formData.badgeType}
                onValueChange={(value) => setFormData({ ...formData, badgeType: value as ModuleForm['badgeType'] })}
              >
                <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <SelectItem value="none">无</SelectItem>
                  <SelectItem value="new">NEW</SelectItem>
                  <SelectItem value="hot">HOT</SelectItem>
                  <SelectItem value="recommend">推荐</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>徽标文字</Label>
              <Input
                value={formData.badgeText}
                onChange={(event) => setFormData({ ...formData, badgeText: event.target.value })}
                placeholder="新品"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>排序权重</Label>
              <Input
                data-testid="prompt-sort-order-input"
                type="number"
                min="0"
                max="1000"
                value={formData.sortOrder}
                onChange={(event) => setFormData({ ...formData, sortOrder: event.target.value })}
                placeholder="0"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>
          </div>

          {mode === 'prompt' && <>
          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>模块提示词 *</Label>
            <Textarea
              data-testid="prompt-content-input"
              value={formData.content}
              onChange={(event) => setFormData({ ...formData, content: event.target.value })}
              placeholder="用户点击该模块进入 chat 后，模块会使用这里的提示词"
              rows={4}
              className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>模块系统提示词</Label>
            <Textarea
              value={formData.systemPrompt}
              onChange={(event) => setFormData({ ...formData, systemPrompt: event.target.value })}
              placeholder="这个模块下 AI 的角色和行为边界"
              rows={3}
              className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label style={{ color: 'var(--text-secondary)' }}>用户输入模板</Label>
            <Textarea
              value={formData.userPromptTemplate}
              onChange={(event) => setFormData({ ...formData, userPromptTemplate: event.target.value })}
              placeholder="使用 {{input}} 表示用户输入"
              rows={3}
              className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] font-mono text-sm"
            />
          </div>

          </>}
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>功能特点</Label>
              <Textarea
                value={formData.features}
                onChange={(event) => setFormData({ ...formData, features: event.target.value })}
                placeholder="每行一个"
                rows={4}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>使用示例</Label>
              <Textarea
                value={formData.examples}
                onChange={(event) => setFormData({ ...formData, examples: event.target.value })}
                placeholder="每行一个"
                rows={4}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>准备问题</Label>
              <Textarea
                value={formData.userQuestions}
                onChange={(event) => setFormData({ ...formData, userQuestions: event.target.value })}
                placeholder="每行一个"
                rows={4}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)] text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <div>
                <Label style={{ color: 'var(--text-secondary)' }}>前台展示</Label>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  关闭后该模块不会出现在功能广场。
                </p>
              </div>
              <Switch
                data-testid="module-active-switch"
                checked={formData.active}
                onCheckedChange={(checked) => setFormData({ ...formData, active: checked })}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <div>
                <Label style={{ color: 'var(--text-secondary)' }}>精选置顶</Label>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  开启后进入首页和功能广场精选列表。
                </p>
              </div>
              <Switch
                data-testid="module-featured-switch"
                checked={formData.isFeatured}
                onCheckedChange={(checked) => setFormData({ ...formData, isFeatured: checked })}
              />
            </div>
          </div>
        </fieldset>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={closeDialog}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            取消
          </Button>
          <Button
            data-testid="prompt-save"
            onClick={handleSubmit}
            disabled={!formData.title
              || (mode === 'prompt' ? !formData.content : !skillIdentity || !formData.modelId || !skillForm.reviewed
                || !skillForm.files.length || skillForm.steps.some(s => !s.title.trim() || !s.resources.length))
              || skillReading || skillLoading || saveSkill.isPending || createPrompt.isPending || updatePrompt.isPending}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            {saveSkill.isPending || createPrompt.isPending || updatePrompt.isPending ? '保存中...' : mode === 'skill' ? '发布 Skill 与模块' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
