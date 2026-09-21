/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  History,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Send,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';

type TopicType = 'article' | 'image_text' | 'video';
type Topic = {
  id: string;
  title: string;
  angle: string;
  type: TopicType;
  platform: string;
};
type Message = { id: string; role: 'agent' | 'user' | 'system'; body: string };
type SampleState = {
  targetId: string;
  viewedId: string;
  panelOpen: boolean;
  adoptedIds: string[];
  adoptionCollapsed: boolean;
  selectedIds: string[];
  documentBody: string;
  documentVersion: number;
  documentDirty: boolean;
  historyVersion: number | null;
  newDraftReady: boolean;
  videoEnded: boolean;
  method: string;
  entryKind: 'new' | 'existing';
  messages: Message[];
};

const storageKey = 'graylum-agent-first-u1-sample-v2';
const topics: Topic[] = [
  {
    id: 'topic-framing-check',
    title: '拍摄前先做这三个构图检查',
    angle: '用一张检查清单，把抽象构图原则变成拍摄前能执行的小动作。',
    type: 'image_text',
    platform: '小红书',
  },
  {
    id: 'topic-beginner-mistakes',
    title: '新手最常见的三种构图误区',
    angle: '从真实失败照片切入，解释为什么“把主体放中间”不是唯一答案。',
    type: 'article',
    platform: '公众号',
  },
  {
    id: 'topic-live-demo',
    title: '一次实拍：把杂乱画面整理清楚',
    angle: '用同一场景的调整过程，让新手看见取景、移动和取舍。',
    type: 'video',
    platform: '视频号',
  },
];
const initialArticle = `很多人第一次学构图，会把“主体放中间”当成一条不能违反的规则。

真正需要判断的不是主体在哪，而是观众第一眼会看到什么。先看画面里最亮、最乱和最靠近边缘的东西，再决定主体的位置。

这篇文章会用三张失败照片，逐一解释背景抢戏、边缘截断和留白失衡。每个误区都配一个可以当场重拍的小练习。`;
const revisedArticle = `构图不是把主体塞进某条线，而是主动决定观众先看哪里。

我们用三张真实失败照片拆解：背景比主体更抢眼、画面边缘意外截断、留白没有方向。每一段都给出一次能立刻重拍的调整。

读完后，你不需要记住更多规则，只需要在按快门前问自己：画面里有没有东西在和主体争夺注意力？`;

const initialState: SampleState = {
  targetId: 'week-topics',
  viewedId: 'topic-beginner-mistakes',
  panelOpen: true,
  adoptedIds: ['topic-live-demo'],
  adoptionCollapsed: false,
  selectedIds: ['topic-framing-check'],
  documentBody: initialArticle,
  documentVersion: 1,
  documentDirty: false,
  historyVersion: null,
  newDraftReady: false,
  videoEnded: false,
  method: '内容深化方法',
  entryKind: 'existing',
  messages: [
    {
      id: 'm1',
      role: 'agent',
      body: '我根据已确认的摄影课程定位整理了三条候选。你可以先查看详情，也可以直接继续其中一条；查看不会改变正在处理的工作。',
    },
  ],
};

const typeLabel: Record<TopicType, string> = {
  article: '文章',
  image_text: '图文',
  video: '视频',
};

function readState(): SampleState {
  if (typeof window === 'undefined') return initialState;
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '') as Partial<SampleState>;
    return { ...initialState, ...parsed };
  } catch {
    return initialState;
  }
}

function TopicCard({
  topic,
  state,
  onPreview,
  onFocus,
  onSelect,
}: {
  topic: Topic;
  state: SampleState;
  onPreview: () => void;
  onFocus: () => void;
  onSelect: (checked: boolean) => void;
}) {
  const adopted = state.adoptedIds.includes(topic.id);
  return (
    <article className="group rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4 transition-colors hover:border-white/20">
      <div className="flex items-start gap-3">
        {!adopted && (
          <input
            aria-label={`选择采用 ${topic.title}`}
            type="checkbox"
            checked={state.selectedIds.includes(topic.id)}
            onChange={(event) => onSelect(event.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
            <span>{typeLabel[topic.type]}</span>
            <span aria-hidden="true">·</span>
            <span>{topic.platform}</span>
            <span className="rounded-full border border-white/10 px-2 py-0.5">
              {adopted ? '已采用' : '草稿'}
            </span>
          </div>
          <button
            type="button"
            onClick={onPreview}
            className="mt-2 text-left text-base font-semibold text-[var(--text-primary)] underline-offset-4 hover:text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          >
            {topic.title}
          </button>
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--text-secondary)]">{topic.angle}</p>
          <Button className="mt-3" size="sm" variant={state.targetId === topic.id ? 'secondary' : 'outline'} onClick={onFocus}>
            {state.targetId === topic.id ? '正在处理这条' : '继续这条'}
          </Button>
        </div>
      </div>
    </article>
  );
}

function DocumentPane({
  state,
  viewed,
  onState,
  onClose,
}: {
  state: SampleState;
  viewed: Topic;
  onState: (patch: Partial<SampleState>) => void;
  onClose: () => void;
}) {
  const isTarget = state.targetId === viewed.id;
  const article = viewed.type === 'article';
  const video = viewed.type === 'video';
  const displayedBody = state.historyVersion === 1 ? initialArticle : state.documentBody;
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--border-primary)] px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-[var(--color-primary)]">当前资料</p>
          <h2 className="mt-1 truncate text-lg font-semibold">{viewed.title}</h2>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {typeLabel[viewed.type]} · {viewed.platform} · {isTarget ? '当前操作目标' : '仅查看，操作目标未改变'}
          </p>
        </div>
        <Button aria-label="关闭当前资料" size="icon" variant="ghost" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <section className="rounded-xl border border-white/10 bg-black/10 p-4">
          <p className="text-xs text-[var(--text-tertiary)]">选题简报 · 已保存</p>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{viewed.angle}</p>
        </section>

        {article && (
          <section className="mt-5 space-y-3" aria-label="文章文档">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold">文章草稿 · 第 {state.historyVersion ?? state.documentVersion} 版</h3>
                <p className="text-xs text-[var(--text-tertiary)]">
                  {state.historyVersion ? '正在查看历史版本' : state.documentDirty ? '有未保存修改' : '已保存草稿'}
                </p>
              </div>
              <details className="relative">
                <summary className="cursor-pointer list-none rounded-md border border-white/10 px-3 py-2 text-xs">
                  <History className="mr-1 inline h-3.5 w-3.5" />版本
                </summary>
                <div className="absolute right-0 z-10 mt-2 w-48 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 shadow-lg">
                  <button className="w-full rounded p-2 text-left text-sm hover:bg-white/5" onClick={() => onState({ historyVersion: null })}>当前草稿 · v{state.documentVersion}</button>
                  <button className="w-full rounded p-2 text-left text-sm hover:bg-white/5" onClick={() => onState({ historyVersion: 1 })}>历史草稿 · v1</button>
                </div>
              </details>
            </div>
            {state.newDraftReady && (
              <button
                className="w-full rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 p-3 text-left text-sm"
                onClick={() => onState({ documentBody: revisedArticle, documentVersion: state.documentVersion + 1, documentDirty: false, historyVersion: null, newDraftReady: false })}
              >
                新草稿已到达。当前视图受保护，点击查看新版本。
              </button>
            )}
            <Textarea
              aria-label="文章正文"
              value={displayedBody}
              readOnly={state.historyVersion !== null || !isTarget}
              onChange={(event) => onState({ documentBody: event.target.value, documentDirty: true })}
              className="min-h-[22rem] resize-none border-0 bg-transparent px-0 text-[15px] leading-7 focus-visible:ring-0"
            />
            {state.historyVersion ? (
              <Button variant="outline" onClick={() => onState({ historyVersion: null })}>回到当前草稿</Button>
            ) : isTarget ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!state.documentDirty}
                  onClick={() => onState({ documentVersion: state.documentVersion + 1, documentDirty: false })}
                >
                  保存修改
                </Button>
                <span className="text-xs text-[var(--text-tertiary)]">保存只更新这份文档，不追加一次 Agent 调用。</span>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-tertiary)]">这是预览。选择“继续这条”后才能修改。</p>
            )}
          </section>
        )}

        {video && (
          <section className="mt-5 space-y-4" aria-label="视频文档">
            <div>
              <p className="text-xs text-[var(--text-tertiary)]">口播稿 · 第 1 版 · 已定稿</p>
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7">先别急着背构图口诀。跟我看同一个场景：我先移走背景里最亮的杯子，再向左一步，让人物和窗边形成清楚的层次。画面变干净，不是因为套了模板，而是我们决定了观众先看哪里。</p>
            </div>
            {isTarget && (state.videoEnded ? (
              <div className="rounded-xl border border-white/10 bg-black/10 p-4">
                <p className="font-medium">本次已暂时结束</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">口播稿和停止选择已保留，没有生成分镜或剪辑建议。</p>
                <Button className="mt-3" variant="outline" onClick={() => onState({ videoEnded: false })}>继续这版视频</Button>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-black/10 p-4">
                <p className="font-medium">口播稿已定稿</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">后续由 Agent 结合 Skill 和实际成果询问；定稿本身不会启动下一次生成。</p>
                <Button className="mt-3" variant="ghost" onClick={() => onState({ videoEnded: true })}>暂时结束</Button>
              </div>
            ))}
          </section>
        )}

        {viewed.type === 'image_text' && (
          <section className="mt-5 rounded-xl border border-white/10 bg-black/10 p-4">
            <p className="text-xs text-[var(--text-tertiary)]">图文结构 · 草稿</p>
            <p className="mt-2 text-sm leading-6">封面：构图前的三个检查。正文依次检查视觉焦点、边缘干扰和留白方向。图片仍需用户提供或另行授权制作，本样片不承诺自动生成图片。</p>
          </section>
        )}
      </div>
    </div>
  );
}

export function AgentFirstWorkspaceSample() {
  const [state, setState] = useState<SampleState>(initialState);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState('');
  const [entryOpen, setEntryOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  useEffect(() => { setState(readState()); setReady(true); }, []);
  useEffect(() => { if (ready) localStorage.setItem(storageKey, JSON.stringify(state)); }, [ready, state]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
    const sync = () => {
      setNarrow(media.matches);
      if (!media.matches) setMobilePanelOpen(false);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const viewed = topics.find((topic) => topic.id === state.viewedId) ?? topics[1];
  const target = topics.find((topic) => topic.id === state.targetId);
  const update = (patch: Partial<SampleState>) => setState((current) => ({ ...current, ...patch }));
  const currentLabel = target ? target.title : '本周选题';
  const messages = state.messages;
  function openDocument(topic: Topic) {
    update({ viewedId: topic.id, panelOpen: true });
    if (narrow) setMobilePanelOpen(true);
  }
  function preview(topic: Topic) { openDocument(topic); }
  function focus(topic: Topic) {
    update({
      targetId: topic.id,
      viewedId: topic.id,
      panelOpen: true,
      historyVersion: null,
      messages: [...state.messages, { id: crypto.randomUUID(), role: 'system', body: `当前工作已切换为“${topic.title}”。原选题讨论和其他草稿保持不变。` }],
    });
    if (narrow) setMobilePanelOpen(true);
  }
  function selectTopic(id: string, checked: boolean) {
    update({ selectedIds: checked ? [...new Set([...state.selectedIds, id])] : state.selectedIds.filter((value) => value !== id) });
  }
  function adoptSelected() {
    if (!state.selectedIds.length) return;
    update({ adoptedIds: [...new Set([...state.adoptedIds, ...state.selectedIds])], selectedIds: [], adoptionCollapsed: true });
  }
  function send() {
    const text = input.trim();
    if (!text) return;
    const next: Message[] = [...state.messages, { id: crypto.randomUUID(), role: 'user', body: text }];
    if (target?.type === 'article') {
      next.push({ id: crypto.randomUUID(), role: 'agent', body: '这是一条交互样片回复：实际专业分析、追问和写法由当前 Skill 决定。这里仅演示新草稿如何绑定当前文章并进入文档区。' });
      const panelVisible = narrow ? mobilePanelOpen : state.panelOpen;
      const protectedView = !panelVisible || state.documentDirty || state.historyVersion !== null || state.viewedId !== target.id;
      update({
        messages: next,
        newDraftReady: protectedView,
        ...(protectedView ? {} : { documentBody: revisedArticle, documentVersion: state.documentVersion + 1 }),
      });
    } else {
      next.push({ id: crypto.randomUUID(), role: 'agent', body: '实际回应将由适用 Skill 根据当前资料生成。本样片只验证工作目标、查看和保存不会串线。' });
      update({ messages: next });
    }
    setInput('');
  }
  function reset() { localStorage.removeItem(storageKey); setState(initialState); setInput(''); setMobilePanelOpen(false); }
  if (!ready) return <main className="min-h-dvh bg-[var(--bg-primary)] p-6 text-[var(--text-primary)]">正在准备交互样片…</main>;

  const document = (
    <DocumentPane
      state={state}
      viewed={viewed}
      onState={update}
      onClose={() => narrow ? setMobilePanelOpen(false) : update({ panelOpen: false })}
    />
  );
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <AppHeader />
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--border-primary)] bg-[var(--bg-primary)] px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button aria-label="返回" size="icon" variant="ghost" onClick={() => window.history.back()}><ArrowLeft /></Button>
              <div className="min-w-0">
                <p className="truncate text-sm text-[var(--text-tertiary)]">摄影课程 · 新手体验</p>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
                  <h1 className="truncate font-semibold">正在做：{currentLabel}</h1>
                  {target && <span className="hidden rounded-full border border-white/10 px-2 py-0.5 text-xs text-[var(--text-tertiary)] sm:inline">{typeLabel[target.type]}</span>}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEntryOpen(true)}>定位入口</Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => narrow ? setMobilePanelOpen((open) => !open) : update({ panelOpen: !state.panelOpen })}
              >
                {(narrow ? mobilePanelOpen : state.panelOpen) ? <PanelRightClose /> : <PanelRightOpen />}
                当前资料
              </Button>
              <Button aria-label="重新体验样片" size="icon" variant="ghost" onClick={reset}><RotateCcw /></Button>
            </div>
          </div>
          <details className="mx-auto mt-3 max-w-[90rem] rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
            <summary className="cursor-pointer text-[var(--text-secondary)]">
              本次依据：正式定位 v1 · 面向刚开始系统学习摄影的新手 · 已引用 2 项资料
            </summary>
            <div className="mt-3 grid gap-3 border-t border-white/10 pt-3 text-xs text-[var(--text-tertiary)] sm:grid-cols-3">
              <p><strong className="block text-[var(--text-secondary)]">已确认</strong>用真实拍摄案例解释摄影基础</p>
              <p><strong className="block text-[var(--text-secondary)]">待核对</strong>用户每周可完成 2–3 条内容</p>
              <p><strong className="block text-[var(--text-secondary)]">实际引用</strong>正式定位 v1、选题方法当前修订</p>
            </div>
          </details>
          <p className="mx-auto mt-2 max-w-[90rem] text-xs text-[var(--text-tertiary)]">交互样片：操作仅保存在本机浏览器，不调用模型、不写入正式资料。</p>
        </header>

        <div className={`mx-auto grid min-h-0 w-full max-w-[90rem] flex-1 ${state.panelOpen ? 'xl:grid-cols-[minmax(400px,0.9fr)_minmax(480px,1.1fr)]' : 'grid-cols-1'}`}>
          <section className="flex min-h-0 min-w-0 flex-col" aria-label="Agent 对话">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              <div className="mx-auto max-w-3xl space-y-5">
                {messages.map((message) => message.role === 'system' ? (
                  <p key={message.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-[var(--text-secondary)]">{message.body}</p>
                ) : (
                  <article key={message.id} className={`flex items-start gap-3 ${message.role === 'user' ? 'justify-end' : ''}`}>
                    {message.role === 'agent' && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--bg-primary)]"><Bot className="h-4 w-4" /></span>}
                    <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'rounded-br-sm bg-[var(--color-primary)] text-[var(--bg-primary)]' : 'rounded-bl-sm border border-[var(--border-primary)] bg-[var(--bg-secondary)]'}`}>{message.body}</p>
                    {message.role === 'user' && <User className="mt-3 h-5 w-5 shrink-0 text-[var(--text-secondary)]" />}
                  </article>
                ))}

                <section aria-label="本周选题候选" className="space-y-3">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">本周选题候选</h2>
                      <p className="mt-1 text-xs text-[var(--text-tertiary)]">标题可直接查看；“继续这条”才改变当前工作。</p>
                    </div>
                    {state.adoptionCollapsed && <Button size="sm" variant="ghost" onClick={() => update({ adoptionCollapsed: false })}>查看剩余草稿 <ChevronDown /></Button>}
                  </div>
                  {!state.adoptionCollapsed && (
                    <div className="grid gap-3 md:grid-cols-2">
                      {topics.map((topic) => <TopicCard key={topic.id} topic={topic} state={state} onPreview={() => preview(topic)} onFocus={() => focus(topic)} onSelect={(checked) => selectTopic(topic.id, checked)} />)}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
                    <span className="text-sm text-[var(--text-secondary)]">已采用 {state.adoptedIds.length} 条 · 草稿 {topics.length - state.adoptedIds.length} 条</span>
                    {!state.adoptionCollapsed && state.selectedIds.length > 0 && <Button size="sm" onClick={adoptSelected}>采用所选 {state.selectedIds.length} 条</Button>}
                    {state.adoptionCollapsed && <span role="status" className="flex items-center gap-1 text-sm text-green-400"><Check className="h-4 w-4" />所选内容已保存，剩余草稿仍可继续讨论。</span>}
                  </div>
                </section>

                {target?.type === 'video' && (
                  <section className="rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-4">
                    <p className="font-medium">{state.videoEnded ? '本次视频工作已暂时结束' : '口播稿已定稿'}</p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">{state.videoEnded ? '重进后不会自动催促或生成。' : '是否继续由实际 Skill 和当前成果决定；定稿不代表授权派生。'}</p>
                    <Button className="mt-3" variant={state.videoEnded ? 'outline' : 'ghost'} onClick={() => update({ videoEnded: !state.videoEnded })}>{state.videoEnded ? '继续这版视频' : '暂时结束'}</Button>
                  </section>
                )}
              </div>
            </div>
            <footer className="shrink-0 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 sm:p-4">
              <div className="mx-auto max-w-3xl">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-tertiary)]">
                  <label className="flex items-center gap-2">工作方法
                    <select aria-label="工作方法" value={state.method} onChange={(event) => update({ method: event.target.value })} className="rounded-md border border-white/10 bg-[var(--bg-primary)] px-2 py-1 text-[var(--text-secondary)]">
                      <option>内容深化方法</option>
                      <option>案例叙事方法</option>
                    </select>
                  </label>
                  <span>当前目标：{currentLabel}</span>
                </div>
                <div className="flex items-end gap-2 rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 focus-within:border-[var(--color-primary)]">
                  <Textarea aria-label="消息" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder={target ? `继续讨论“${target.title}”…` : '告诉 Agent 想查看、采用或继续哪条选题…'} rows={2} className="min-h-12 max-h-32 resize-none border-0 bg-transparent focus-visible:ring-0" />
                  <Button aria-label="发送" size="icon" disabled={!input.trim()} onClick={send}><Send /></Button>
                </div>
              </div>
            </footer>
          </section>
          {state.panelOpen && <aside className="hidden min-h-0 border-l border-[var(--border-primary)] xl:block" aria-label="当前资料文档">{document}</aside>}
        </div>
      </div>

      <Sheet open={narrow && mobilePanelOpen} onOpenChange={setMobilePanelOpen} modal={false}>
        <SheetContent side="right" className="w-full overflow-hidden border-[var(--border-primary)] bg-[var(--bg-secondary)] p-0 text-[var(--text-primary)] sm:max-w-xl">
          <SheetHeader className="sr-only"><SheetTitle>当前资料</SheetTitle></SheetHeader>
          {document}
        </SheetContent>
      </Sheet>

      <Dialog open={entryOpen} onOpenChange={setEntryOpen}>
        <DialogContent className="bg-[var(--bg-secondary)] text-[var(--text-primary)]">
          <DialogHeader><DialogTitle>从同一个 Agent 工作区开始</DialogTitle></DialogHeader>
          <p className="text-sm text-[var(--text-secondary)]">没有正式定位时只做一次必要选择；两条入口使用同一资料和进度，不建立两套流程。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button className="rounded-xl border border-white/10 p-4 text-left hover:border-[var(--color-primary)]" onClick={() => { update({ entryKind: 'new' }); setEntryOpen(false); }}><Sparkles className="mb-3 text-[var(--color-primary)]" /><strong>我是新手</strong><span className="mt-1 block text-sm text-[var(--text-secondary)]">由定位 Skill 从已有经历开始引导。</span></button>
            <button className="rounded-xl border border-white/10 p-4 text-left hover:border-[var(--color-primary)]" onClick={() => { update({ entryKind: 'existing' }); setEntryOpen(false); }}><BookOpen className="mb-3 text-[var(--color-primary)]" /><strong>我已有定位</strong><span className="mt-1 block text-sm text-[var(--text-secondary)]">带入同一份资料，在工作区核对与补齐。</span></button>
          </div>
          <p role="status" className="text-xs text-[var(--text-tertiary)]">当前入口：{state.entryKind === 'new' ? '新手引导' : '已有定位'}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
