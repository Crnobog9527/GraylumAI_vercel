/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { DocumentList, UploadPanel } from '@/components/library/my-documents-view';
import docs from '@/components/library/my-documents.module.css';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { LibraryDocument } from '@/hooks/use-library-documents';
import type { UploadItem } from '@/hooks/use-library-uploads';
import { L_SHOWCASE_LIBRARY as LIB, L_SHOWCASE_VOICE as VOICE } from '@/lib/landing/landing-copy-l-showcase';
import { ChatWindowL, LibraryWindowL, SourcesL } from './ShowcaseWindowsL';
import showcase from './showcase-l.module.css';

const noop = () => undefined;

/** The example's files as the library lists them; noon UTC keeps the shown date the same in every time zone. */
const DOCUMENTS: LibraryDocument[] = LIB.documents.map((item, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`, kind: 'document', format: item.format, purpose: item.purpose,
  filename: item.filename, status: 'ready', original_bytes: item.bytes, text_bytes: Math.round(item.bytes * 0.9), content_version: 1,
  created_at: `2026-10-1${index}T12:00:00Z`,
}));

/** 资料库, step by step: the real "我的文档" list, then two new conversations that use it. */
export function LibraryPictureL({ beat }: { beat: number }) {
  if (beat === 0) {
    return (
      <LibraryWindowL>
        <DocumentList documents={DOCUMENTS} ready onOpen={noop} onDownload={noop} onDelete={noop} onPurpose={noop} />
      </LibraryWindowL>
    );
  }
  if (beat === 1) {
    return (
      <ChatWindowL turns={[
        { role: 'user', text: LIB.ask.user },
        { role: 'coach', text: LIB.ask.coach, extra: <SourcesL label={LIB.sourcesLabel} items={LIB.ask.sources} /> },
      ]} />
    );
  }
  return (
    <ChatWindowL turns={[
      { role: 'marker', text: LIB.later.marker },
      { role: 'user', text: LIB.later.user },
      { role: 'coach', text: [LIB.later.coach], extra: <SourcesL label={LIB.sourcesLabel} items={LIB.later.sources} /> },
    ]} />
  );
}

/**
 * 文风参考, step by step. Step 1 is the library's real upload panel. The voice profile and the "使用我的文风" switch are
 * not built yet (VOICE): they are drawn from the approved description with the library's own panel card (my-documents.module.css), the product's
 * Button and Switch and its light tokens, so they sit in the product as the rest of it does.
 */
export function VoicePictureL({ beat }: { beat: number }) {
  if (beat === 0) {
    const uploads: UploadItem[] = VOICE.files.map(filename => ({ key: filename, filename, purpose: 'authored', status: 'done', progress: 1 }));
    return (
      <LibraryWindowL>
        <UploadPanel uploadEnabled spaceKnown usedBytes={0} capacityBytes={500_000_000} uploads={uploads}
          onAdd={noop} onRetry={noop} onDismiss={noop} />
      </LibraryWindowL>
    );
  }
  if (beat === 1) return <LibraryWindowL><ProfileL /></LibraryWindowL>;
  const { write } = VOICE;
  return (
    <ChatWindowL
      meta={<div className={showcase.toggle}><Switch checked tabIndex={-1} />{write.toggle}</div>}
      turns={[
        { role: 'user', text: write.user },
        { role: 'coach', text: [write.coach], extra: <CompareL /> },
        { role: 'user', text: write.reply },
      ]} />
  );
}

/** The voice profile as the plan describes it: what it found, one passage most like you, its sources, edit or confirm. */
function ProfileL() {
  const { profile } = VOICE;
  return (
    <div className={docs.panel}>
      <div className={showcase.cardHead}>
        <span className={showcase.cardTitle}>{profile.title}</span>
        <span className={showcase.tag}>{profile.status}</span>
      </div>
      <dl className={showcase.rows}>
        {profile.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <figure className={showcase.sample}>
        <figcaption>{profile.sampleLabel}</figcaption>
        <blockquote>{profile.sample}</blockquote>
      </figure>
      <p className={showcase.basis}>{profile.basis}</p>
      <div className={showcase.actions}>
        <Button size="sm" variant="outline" tabIndex={-1}>{profile.edit}</Button>
        <Button size="sm" tabIndex={-1}>{profile.confirm}</Button>
      </div>
    </div>
  );
}

/** Your own old passage beside the new draft in your voice; the generic AI line underneath, quieter. */
function CompareL() {
  const { write, profile } = VOICE;
  return (
    <div className={showcase.compare}>
      <div className={showcase.side}><span>{write.mine}</span><p>{profile.sample}</p></div>
      <div className={showcase.side} data-draft=""><span>{write.draft}</span><p>{write.draftText}</p></div>
      <p className={showcase.generic}><span>{write.generic}</span>{write.genericText}</p>
    </div>
  );
}
