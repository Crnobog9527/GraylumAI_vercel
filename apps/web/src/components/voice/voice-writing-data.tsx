'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { LABEL_TYPES, topicsFromText, type VoiceLabel, type VoiceLabelType, type VoiceStats, type VoiceVersion } from '@/lib/voice/format';
import styles from './my-voice.module.css';

/** VOICE-2 PR-4: the writing stats of a version, computed by code (no charge), as plain numbers. */
export function VoiceStatsList({ stats }: { stats: VoiceStats }) {
  if (!stats.sentences) return null;
  const rows: Array<[string, string]> = [
    ['句子', `平均每句 ${stats.avgSentenceChars} 字；短句（10 字以内）占 ${stats.shortSentenceShare}%，长句（30 字以上）占 ${stats.longSentenceShare}%`],
    ['段落开头', `问句 ${stats.openings.question}%，数字或列表 ${stats.openings.number}%，以“我”开头 ${stats.openings.firstPerson}%`],
    ['标点和表情', `每千字感叹号 ${stats.perThousandChars.exclamation} 个、问号 ${stats.perThousandChars.question} 个、`
      + `省略号 ${stats.perThousandChars.ellipsis} 个、表情 ${stats.perThousandChars.emoji} 个`],
    ['段落', `平均每篇 ${stats.avgParagraphsPerDocument} 段，每段 ${stats.avgParagraphChars} 字；列表段落占 ${stats.listShare}%`],
  ];
  return <div className={styles.writingData} aria-label="写作数据">
    <h3>写作数据<small>从你的 {stats.documents} 篇文章统计，不扣积分</small></h3>
    <dl className={styles.fields}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </div>;
}

type LabelsProps = { version: VoiceVersion; busy: boolean;
  onSetLabel?: (documentId: string, type: VoiceLabelType, topics: string[]) => Promise<boolean> };
/** VOICE-2 PR-4: what each read document is (type, topics), which writing uses to pick past pieces as examples; the user may correct it. */
export function VoiceLabels({ version, busy, onSetLabel }: LabelsProps) {
  const labels = version.documents ?? [];
  if (!labels.length) return null;
  const names = new Map(version.sources.map(source => [source.documentId, source.filename ?? '未命名']));
  return <div className={styles.labels} aria-label="每篇文章的类型和话题">
    <h3>每篇文章的类型和话题<small>写稿时会挑同类型、不同话题的几篇参考语气，标错了可以改</small></h3>
    <ul>{labels.map(label => <LabelRow key={label.documentId + label.type + label.topics.join()} label={label}
      name={names.get(label.documentId) ?? '未命名'} busy={busy} onSetLabel={onSetLabel} />)}</ul>
  </div>;
}

function LabelRow({ label, name, busy, onSetLabel }: { label: VoiceLabel; name: string; busy: boolean; onSetLabel: LabelsProps['onSetLabel'] }) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<VoiceLabelType>(label.type);
  const [topics, setTopics] = useState(label.topics.join('、'));
  const typeName = LABEL_TYPES.find(([value]) => value === label.type)?.[1] ?? '其他';
  if (!editing) return <li>
    <span className={styles.labelName}>{name}</span>
    <span>{typeName}{label.topics.length ? ` · ${label.topics.join('、')}` : ''}{label.edited ? '（已修改）' : ''}</span>
    {onSetLabel && <button type="button" disabled={busy} onClick={() => setEditing(true)}>修改</button>}
  </li>;
  return <li className={styles.labelEdit}>
    <span className={styles.labelName}>{name}</span>
    <select aria-label={`${name} 的类型`} value={type} onChange={event => setType(event.target.value as VoiceLabelType)}>
      {LABEL_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
    <input aria-label={`${name} 的话题`} value={topics} maxLength={120} placeholder="话题，用顿号或逗号隔开，最多 5 个"
      onChange={event => setTopics(event.target.value)} />
    <button type="button" className={styles.primary} disabled={busy} onClick={() => void onSetLabel?.(label.documentId, type,
      topicsFromText(topics)).then(saved => { if (saved) setEditing(false); })}>保存</button>
    <button type="button" disabled={busy} onClick={() => { setType(label.type); setTopics(label.topics.join('、')); setEditing(false); }}>取消</button>
  </li>;
}
