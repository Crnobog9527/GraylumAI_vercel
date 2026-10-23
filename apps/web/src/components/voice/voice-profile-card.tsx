'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { DisplayHeading } from '@/components/chat-display/display-heading';
import { fromForm, LIST_FIELDS, TEXT_FIELDS, toForm, type VoiceForm, type VoiceProfile, type VoiceVersion } from '@/lib/voice/format';
import styles from './my-voice.module.css';

type Props = { version: VoiceVersion; title: string; busy: boolean;
  /** Draft: "确认使用"; confirmed: "保存修改" (a new confirmed version). Absent: read-only. */
  onConfirm?: (profile: VoiceProfile) => void; onDelete?: () => void };

/** One profile version: read view, or the form the user edits before confirming (5.3 step 3). */
export function VoiceProfileCard({ version, title, busy, onConfirm, onDelete }: Props) {
  const draft = version.status === 'draft';
  const [editing, setEditing] = useState(draft);
  const [form, setForm] = useState<VoiceForm | null>(version.profile ? toForm(version.profile) : null);
  const [error, setError] = useState('');
  if (!version.profile || !form) return null;
  const profile = version.profile;
  const set = (key: keyof VoiceForm, value: string) => setForm(current => current && { ...current, [key]: value });
  function submit() {
    const next = form && fromForm(form);
    if (!next) { setError('至少保留两段你自己写的原文。'); return; }
    setError('');
    onConfirm?.(next);
  }
  return <section className={styles.panel} aria-label={title}>
    <div className={styles.cardHead}>
      <DisplayHeading as="h2">{title}</DisplayHeading>
      <span className={styles.badge} data-status={version.status}>
        第 {version.version} 版 · {draft ? '待你确认' : version.status === 'confirmed' ? '已确认' : '已停用'}
      </span>
    </div>
    {version.sources.length > 0 && <p className={styles.hint}>
      依据：{version.sources.map(source => source.filename ?? '未命名').join('、')}
    </p>}
    {editing ? <div className={styles.form}>
      {TEXT_FIELDS.map(([key, label]) => <label key={key}><span>{label}</span>
        <textarea rows={2} maxLength={300} value={form[key]} onChange={event => set(key, event.target.value)} /></label>)}
      {LIST_FIELDS.map(([key, label]) => <label key={key}><span>{label}<small>每行一条</small></span>
        <textarea rows={3} value={form[key]} onChange={event => set(key, event.target.value)} /></label>)}
      <fieldset><legend>最能代表你的原文<small>写稿时会参考这几段</small></legend>
        {form.samples.map((sample, index) => <textarea key={index} rows={3} maxLength={400} value={sample}
          aria-label={`原文片段 ${index + 1}`}
          onChange={event => setForm(current => current && { ...current,
            samples: current.samples.map((value, at) => at === index ? event.target.value : value) })} />)}
      </fieldset>
      {error && <p className={styles.warn} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={submit}>
          {draft ? '确认使用' : '保存修改'}</button>
        {!draft && <button type="button" disabled={busy} onClick={() => { setForm(toForm(profile)); setEditing(false); }}>取消</button>}
        {draft && onDelete && <button type="button" className={styles.danger} disabled={busy} onClick={onDelete}>不用这一版</button>}
      </div>
    </div> : <>
      <dl className={styles.fields}>
        {TEXT_FIELDS.filter(([key]) => profile[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{profile[key]}</dd></div>)}
        {LIST_FIELDS.filter(([key]) => profile[key].length).map(([key, label]) =>
          <div key={key}><dt>{label}</dt><dd>{profile[key].join('、')}</dd></div>)}
      </dl>
      <div className={styles.samples}>{profile.samples.map((sample, index) => <blockquote key={index}>{sample}</blockquote>)}</div>
      {onConfirm && <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>修改</button>
        {onDelete && <button type="button" className={styles.danger} disabled={busy} onClick={onDelete}>删除</button>}
      </div>}
    </>}
  </section>;
}
