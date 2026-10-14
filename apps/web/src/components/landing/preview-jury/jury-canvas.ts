/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  DECISION_LABEL, SEATS, STANCE_LABEL, type DecisionKey, type JurySeatNames, type Seat, type SeatCode,
  type Severity, type Stance, type Verdict,
} from './jury-events';
import { issueIndexAt, replyTurned } from './jury-desk';
import { BEAT, type Scene, type StageKey } from './jury-scenes';

/**
 * Pure read-out of the canvas at a clock time. The report sits in the middle; each person's work grows downward
 * under their mark as a short string of cards that only carry a status word, a count and at most one line of
 * opinion. Lines between the report and the marks light up for what is happening now. Full text lives in the records.
 */
export type CanvasCard =
  | { kind: 'read'; key: string; round: 1 | 2; state: 'reading' | 'done' | 'failed' }
  | { kind: 'decisions'; key: string; marks: { decision: DecisionKey; verdict: Verdict }[]; current: DecisionKey | null }
  | { kind: 'issues'; key: string; shown: number; total: number; severities: Severity[]; line: string | null; where: string | null }
  | { kind: 'stances'; key: string; items: { decision: DecisionKey; verdict: Verdict; turned: boolean }[]; current: DecisionKey | null }
  | { kind: 'replies'; key: string; count: number; latest: { to: Seat; decision: DecisionKey; stance: Stance | null } | null }
  | { kind: 'writing'; key: string; done: boolean }
  | { kind: 'rulings'; key: string; shown: number; total: number; adopted: number; line: string | null; sealed: boolean | null }
  | { kind: 'revision'; key: string; changed: number | null };

export type Node = SeatCode | 'doc';
/** live: the work happening now; split: two sides that disagree; flow: opinions going to the summary. */
export type Edge = { from: Node; to: Node; tone: 'live' | 'split' | 'flow' };

export type CanvasView = {
  stage: StageKey | null;
  /** One short sentence: what is happening now. */
  caption: string;
  /** People the stage is about; everyone else is dimmed. Empty means everyone. */
  focus: SeatCode[];
  /** Key of the card the stage is about. */
  current: string | null;
  columns: Record<SeatCode, CanvasCard[]>;
  edges: Edge[];
  doc: { state: 'waiting' | 'reading' | 'revised' | 'failed'; changed: number };
};

/** "评审 A 开始" but "首席主笔开始": a space only after a name ending in a Latin letter or digit. */
const of = (name: string) => (/[A-Za-z0-9]$/.test(name) ? `${name} ` : name);

const emptyColumns = (): Record<SeatCode, CanvasCard[]> => ({ A: [], B: [], C: [], S: [] });

/** Put a card in a column, replacing the one with the same key (cards update in place as the stage moves on). */
function place(columns: Record<SeatCode, CanvasCard[]>, seat: SeatCode, card: CanvasCard) {
  const list = columns[seat];
  const index = list.findIndex(item => item.key === card.key);
  if (index >= 0) list[index] = card;
  else list.push(card);
}

function find<K extends CanvasCard['kind']>(list: CanvasCard[], key: string, kind: K) {
  return list.find((item): item is Extract<CanvasCard, { kind: K }> => item.key === key && item.kind === kind);
}

export function canvasAt(scenes: readonly Scene[], clock: number, names: JurySeatNames): CanvasView {
  const shown = scenes.filter(scene => scene.start <= clock);
  const last = shown[shown.length - 1] ?? null;
  const columns = emptyColumns();
  const view: CanvasView = {
    stage: last?.stage ?? null, caption: '评审即将开始', focus: [], current: null, columns, edges: [], doc: { state: 'waiting', changed: 0 },
  };

  for (const scene of shown) {
    const now = scene === last;
    const local = clock - scene.start;
    switch (scene.kind) {
      case 'seated':
        if (now) {
          view.caption = `三位评审入席，各自拿到你的报告（${scene.sections} 章）`;
          view.edges = SEATS.map(seat => ({ from: 'doc', to: seat, tone: 'live' }));
        }
        break;
      case 'reading': {
        const key = 'read';
        const waiting: Seat[] = [];
        for (const seat of SEATS) {
          const submitted = clock >= (scene.submitAt[seat] ?? Infinity);
          const state = submitted ? (scene.failed.includes(seat) ? 'failed' : 'done') : 'reading';
          if (state === 'reading') waiting.push(seat);
          place(columns, seat, { kind: 'read', key, round: scene.round, state });
        }
        if (now) {
          view.doc.state = 'reading';
          view.current = key;
          view.focus = waiting;
          view.edges = waiting.map(seat => ({ from: 'doc', to: seat, tone: 'live' }));
          view.caption = waiting.length === 0 ? '三位都交卷了'
            : scene.round === 1 ? '三位评审各自读报告，互相看不到对方的意见' : '第 2 轮：每位评审先读对方的理由，再决定改不改';
        }
        break;
      }
      case 'steelman':
        for (const card of scene.cards) {
          const existing = find(columns[card.seat], 'decisions', 'decisions');
          const marks = [...(existing?.marks ?? []).filter(item => item.decision !== scene.decision),
            { decision: scene.decision, verdict: card.verdict }];
          place(columns, card.seat, { kind: 'decisions', key: 'decisions', marks, current: now ? scene.decision : null });
        }
        if (now) {
          view.current = 'decisions';
          view.caption = `先把报告的选择讲到最强，再判断：${DECISION_LABEL[scene.decision]}`;
          view.edges = scene.cards.map(card => ({ from: 'doc', to: card.seat, tone: 'live' }));
        } else {
          for (const seat of SEATS) {
            const card = find(columns[seat], 'decisions', 'decisions');
            if (card) place(columns, seat, { ...card, current: null });
          }
        }
        break;
      case 'critique': {
        const index = now ? issueIndexAt(scene, clock) : scene.issues.length - 1;
        const issue = now && index >= 0 ? scene.issues[index] : null;
        place(columns, scene.seat, {
          kind: 'issues', key: 'issues', shown: index + 1, total: scene.issues.length,
          severities: scene.issues.slice(0, index + 1).map(item => item.severity),
          line: issue?.problem ?? null, where: issue?.section ?? null,
        });
        if (now) {
          view.current = 'issues';
          view.focus = [scene.seat];
          view.edges = [{ from: 'doc', to: scene.seat, tone: 'live' }];
          view.caption = index < 0 ? `${of(names[scene.seat])}开始挑刺` : `${of(names[scene.seat])}挑出第 ${index + 1} 处问题：${issue?.section}`;
        }
        break;
      }
      case 'divergence': {
        const { decision, keep, change } = scene.split;
        for (const seat of SEATS) {
          const verdict: Verdict | null = keep.includes(seat) ? 'keep' : change.includes(seat) ? 'change' : null;
          const card = find(columns[seat], 'stances', 'stances');
          const items = [...(card?.items ?? []).filter(item => item.decision !== decision), ...(verdict ? [{ decision, verdict, turned: false }] : [])];
          if (items.length > 0) place(columns, seat, { kind: 'stances', key: 'stances', items, current: now && verdict ? decision : null });
        }
        if (now) {
          view.current = 'stances';
          view.focus = [...keep, ...change];
          view.edges = keep.flatMap(from => change.map(to => ({ from, to, tone: 'split' as const })));
          view.caption = `「${DECISION_LABEL[decision]}」意见不一：${keep.length} 位主张保留，${change.length} 位主张要改`;
        }
        break;
      }
      case 'agreed':
        if (now) {
          view.caption = '三位意见一致，不用开第 2 轮';
          view.edges = SEATS.map(seat => ({ from: seat, to: 'S', tone: 'flow' }));
        }
        break;
      case 'response': {
        const { reviewer, to, decision, stance } = scene.response;
        const turned = !now || replyTurned(scene, clock);
        const replies = find(columns[reviewer], 'replies', 'replies');
        place(columns, reviewer, {
          kind: 'replies', key: 'replies', count: (replies?.count ?? 0) + 1, latest: now ? { to, decision, stance: turned ? stance : null } : null,
        });
        const stances = find(columns[reviewer], 'stances', 'stances');
        const was = stances?.items.find(item => item.decision === decision);
        if (turned && stances && was && scene.verdictNow && scene.verdictNow !== was.verdict) {
          const items = stances.items.map(item => (item === was ? { decision, verdict: scene.verdictNow as Verdict, turned: true } : item));
          place(columns, reviewer, { ...stances, items });
        }
        if (now) {
          view.current = 'replies';
          view.focus = [reviewer, to];
          view.edges = [{ from: reviewer, to, tone: 'live' }];
          view.caption = turned ? `${of(names[reviewer])}回应${names[to]}：${STANCE_LABEL[stance]}`
            : `${of(names[reviewer])}先把${of(names[to])}的理由讲到最强`;
        }
        break;
      }
      case 'failed': {
        const { reviewer, round } = scene.failure;
        place(columns, reviewer, { kind: 'read', key: 'read', round, state: 'failed' });
        if (now) {
          view.current = 'read';
          view.focus = [reviewer];
          view.caption = `${of(names[reviewer])}没有给出可用意见，这一轮不计入`;
        }
        break;
      }
      case 'writing':
        place(columns, 'S', { kind: 'writing', key: 'writing', done: !now });
        if (now) {
          view.current = 'writing';
          view.focus = ['S'];
          view.edges = SEATS.map(seat => ({ from: seat, to: 'S', tone: 'flow' }));
          view.caption = `${of(names.S)}读完全部意见，开始汇总`;
        }
        break;
      case 'ruling': {
        const { ruling, index, total } = scene;
        const before = find(columns.S, 'rulings', 'rulings');
        const sealed = now ? (local > BEAT.ruling * 0.5 ? ruling.adopted : null) : ruling.adopted;
        place(columns, 'S', {
          kind: 'rulings', key: 'rulings', shown: index + 1, total, adopted: (before?.adopted ?? 0) + (ruling.adopted && sealed !== null ? 1 : 0),
          line: now ? ruling.opinion : null, sealed: now ? sealed : null,
        });
        if (now) {
          view.current = 'rulings';
          view.focus = ['S', ...ruling.reviewers];
          view.edges = ruling.reviewers.map(seat => ({ from: seat, to: 'S', tone: 'flow' }));
          view.caption = `${of(names.S)}逐条裁决：第 ${index + 1} 条，共 ${total} 条`;
        }
        break;
      }
      case 'revision': {
        const ok = scene.result.type === 'revision_ready_for_choice';
        const changed = scene.result.type === 'revision_ready_for_choice' ? scene.result.changedSections : null;
        place(columns, 'S', { kind: 'revision', key: 'revision', changed });
        view.doc = { state: ok ? 'revised' : 'failed', changed: changed ?? 0 };
        if (now) {
          view.current = 'revision';
          view.focus = ['S'];
          view.edges = [{ from: 'S', to: 'doc', tone: 'live' }];
          view.caption = ok ? `修订稿写好了：改了 ${changed} 章，用不用由你逐章决定` : '修订稿没有通过检查，三位评审的意见仍可参考';
        }
        break;
      }
    }
  }
  return view;
}

/** The status word under a person's mark. */
export function statusWord(view: CanvasView, seat: SeatCode): string {
  const cards = view.columns[seat];
  const latest = cards[cards.length - 1];
  if (cards.some(card => card.kind === 'read' && card.state === 'failed')) return '未计入';
  if (!latest) return seat === 'S' ? '等待汇总' : '在席';
  switch (latest.kind) {
    case 'read': return latest.state === 'reading' ? '在读' : '已交卷';
    case 'decisions': return '判断中';
    case 'issues': return `批注 ${latest.shown} 条`;
    case 'stances': return latest.items.some(item => item.turned) ? '改判了' : '有分歧';
    case 'replies': return latest.latest && !latest.latest.stance ? '回应中' : `回应 ${latest.count} 条`;
    case 'writing': return latest.done ? '已汇总' : '汇总中';
    case 'rulings': return `裁决 ${latest.shown}/${latest.total}`;
    case 'revision': return latest.changed === null ? '未通过检查' : '修订稿已交';
  }
}
