'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DisplayHeading } from '@/components/chat-display/display-heading';
import { formatBytes } from '@/lib/library-documents/format';
import { MAX_PREFERRED, voiceErrorMessage, type VoiceProfile, type VoiceState } from '@/lib/voice/format';
import { VoiceProfileCard } from './voice-profile-card';
import styles from './my-voice.module.css';

export type MyVoiceViewProps = { state: VoiceState; preferred: string[]; busy: boolean; generating: boolean;
  onTogglePreferred: (documentId: string) => void; onGenerate: () => void; onToggleEnabled: (enabled: boolean) => void;
  onConfirm: (versionId: string, profile: VoiceProfile) => void; onDelete: (versionId: string) => void;
  onOpenDocuments: () => void };

/** 资料库「我的文风」(VOICE, Master Plan 5.3). No estimated charge is shown (Owner rule): only that it is billed by use. */
export function MyVoiceView(props: MyVoiceViewProps) {
  const { state, busy } = props;
  const latest = state.latest;
  const running = props.generating || latest?.status === 'generating';
  const hasCorpus = state.documents.length > 0;
  // Saving an edit of the confirmed profile makes a newer version, which would bury a paid result still pending (#1262 review).
  const editLocked = running || latest?.status === 'draft';
  return <div className={styles.root}>
    <section className={styles.panel} aria-label="我的文风">
      <div className={styles.cardHead}>
        <DisplayHeading as="h2">我的文风</DisplayHeading>
        <label className={styles.switch}>
          <input type="checkbox" checked={state.enabled} disabled={busy}
            onChange={event => props.onToggleEnabled(event.target.checked)} />
          写稿时使用我的文风
        </label>
      </div>
      <p className={styles.hint}>
        AI 教练先读你自己写过的文章，总结出你说话的习惯，你确认后，写稿时就按它来。只读你标为「我本人写的」文档，参考资料不会当成你的文风。
      </p>
      {!state.enabled && state.confirmed && <p className={styles.note} role="status">已关闭：写稿时不会使用下面的文风画像。</p>}
      {state.needsUpdate && <p className={styles.note} role="status">
        你「我本人写的」文档有变化，当前画像还没包含这些变化。需要的话可以重新学习。
      </p>}
    </section>

    {running && <section className={styles.panel} aria-live="polite">
      <p className={styles.working}>正在读你的文章、总结文风，一般需要一两分钟，完成后会显示在这里，你可以先去做别的。</p>
    </section>}
    {!running && latest?.status === 'draft' && <VoiceProfileCard key={latest.id} version={latest} title="新的文风画像" busy={busy}
      onConfirm={profile => props.onConfirm(latest.id, profile)} onDelete={() => props.onDelete(latest.id)} />}
    {!running && (latest?.status === 'stale' || latest?.status === 'failed') && <section className={styles.panel}>
      <p className={styles.warn} role="status">
        {latest.status === 'stale' ? voiceErrorMessage('VOICE_STALE') : voiceErrorMessage(latest.failure)}</p>
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => props.onDelete(latest.id)}>知道了</button></div>
    </section>}
    {state.confirmed && <VoiceProfileCard key={state.confirmed.id + ':' + state.confirmed.version} version={state.confirmed}
      title="当前使用的文风画像" busy={busy} onDelete={() => props.onDelete(state.confirmed!.id)}
      onConfirm={editLocked ? undefined : profile => props.onConfirm(state.confirmed!.id, profile)} />}
    {state.confirmed && editLocked && <p className={styles.hint}>
      有一份新的文风画像{running ? '正在生成' : '等你确认'}，先处理它，再修改当前这份。</p>}

    <section className={styles.panel} aria-label="学习我的文风">
      <DisplayHeading as="h2">{state.confirmed ? '重新学习我的文风' : '学习我的文风'}</DisplayHeading>
      {hasCorpus ? <>
        <p className={styles.hint}>勾选最像你平时说话的几篇（最多 {MAX_PREFERRED} 篇），会先读这些；文章很多时只读一部分。</p>
        <ul className={styles.docs}>{state.documents.map(doc => <li key={doc.id}>
          <label><input type="checkbox" checked={props.preferred.includes(doc.id)} disabled={busy || running
            || (!props.preferred.includes(doc.id) && props.preferred.length >= MAX_PREFERRED)}
            onChange={() => props.onTogglePreferred(doc.id)} />
            <span>{doc.filename ?? '未命名'}</span><small>{formatBytes(doc.textBytes)}</small><em>最像我</em></label>
        </li>)}</ul>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || running} onClick={props.onGenerate}>
            {running ? '正在学习…' : state.confirmed ? '重新学习' : '学习我的文风'}</button>
          <span className={styles.hint}>按实际用量扣积分。</span>
        </div>
      </> : <>
        <p className={styles.hint}>{voiceErrorMessage('VOICE_NO_CORPUS')}</p>
        <div className={styles.actions}><button type="button" onClick={props.onOpenDocuments}>去上传文章</button></div>
      </>}
    </section>
  </div>;
}
