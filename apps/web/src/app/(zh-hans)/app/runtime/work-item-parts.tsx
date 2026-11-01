/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { VideoChoice } from './work-input';

/** The work item's choices in the transcript (V2-10b C2), worded as on the old workspace. */
export const TYPE_LABEL: Record<string, string> = { article: '文章', image_text: '图文', video: '视频' };

export function WorkTypeChoice({ disabled, onChoose }: { disabled: boolean; onChoose: (value: string) => void }) {
  return (
    <section className="rounded-xl border p-4" aria-label="确认内容类型">
      <h2>这条选题准备做成什么内容？</h2>
      <p>先确认形式，再一起细化重点和结构。</p>
      <div className="mt-3 flex gap-2">
        {Object.keys(TYPE_LABEL).map(value => (
          <Button key={value} disabled={disabled} onClick={() => onChoose(value)}>
            {TYPE_LABEL[value]}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function WorkAdoptAction({ adopted, isVideo, href, disabled, onAdopt }: {
  adopted: boolean; isVideo: boolean; href: string; disabled: boolean; onAdopt: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {adopted ? (
        <Link className="underline" href={href}>
          {isVideo ? '这版口播稿已定稿' : '已采用为草稿'} · 查看
        </Link>
      ) : (
        <Button disabled={disabled} onClick={onAdopt}>
          {isVideo ? '将这条回复定稿为口播稿' : '采用为当前草稿'}
        </Button>
      )}
    </div>
  );
}

export function WorkResultAction({ version, disabled, onSave }: { version: number | null; disabled: boolean; onSave: () => void }) {
  return (
    <div className="mt-2">
      {version !== null ? (
        <p role="status">已保存成果 · 第 {version} 版</p>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={onSave}>
          保存 Skill 成果
        </Button>
      )}
    </div>
  );
}

export function WorkVideoChoices({ version, storyboard, editing, busy, onChoose }: {
  version: number; storyboard: boolean; editing: boolean; busy: boolean; onChoose: (choice: VideoChoice | 'end') => void;
}) {
  return (
    <section aria-label="口播稿后续选择" className="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
      <h2 className="font-medium">{storyboard ? '分镜已保存。要基于这版分镜生成剪辑建议吗？' : '口播稿已定稿。要先制作分镜脚本吗？'}</h2>
      <p className="text-sm text-[var(--text-secondary)]">
        本次只绑定口播稿第 {version} 版。选择后才会调用 Agent；以后重新定稿口播稿时不会自动生成。
      </p>
      <div className="flex flex-wrap gap-2">
        {!storyboard && <Button disabled={busy || editing} onClick={() => onChoose('both')}>先做分镜，再生成剪辑建议</Button>}
        {!storyboard && <Button variant="outline" disabled={busy} onClick={() => onChoose('storyboard')}>只生成分镜</Button>}
        {storyboard && <Button variant="outline" disabled={busy || editing} onClick={() => onChoose('editing')}>只生成剪辑建议</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => onChoose('end')}>暂时结束</Button>
      </div>
      <p className="text-xs text-[var(--text-tertiary)]">也可以在消息框输入同样的选择；提问卡和自然语言只执行同一个业务动作。</p>
    </section>
  );
}
