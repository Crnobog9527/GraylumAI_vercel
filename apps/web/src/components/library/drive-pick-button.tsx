'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { toast } from 'sonner';
import { downloadPicked, driveErrorMessage } from '@/lib/google-drive/download';
import { pickDriveFiles, requestDriveToken } from '@/lib/google-drive/picker';
import { libraryGoogleDriveConfig, type GoogleDriveConfig } from '@/lib/library-sandbox/feature-flag';
import styles from './my-documents.module.css';

/** VOICE-2 PR-7: 「从 Google 云端硬盘选择」. Hidden until the three Google settings exist; the picked files go through the library's own upload. */
export function DrivePickButton({ disabled, onFiles, config = libraryGoogleDriveConfig() }: { disabled: boolean; onFiles: (files: File[]) => void;
  config?: GoogleDriveConfig | null }) {
  const [busy, setBusy] = useState(false);
  if (!config) return null;
  async function pick() {
    setBusy(true);
    try {
      const token = await requestDriveToken(config!);
      const picked = await pickDriveFiles(config!, token);
      const files: File[] = [];
      for (const file of picked) {
        try { files.push(await downloadPicked(file, token)); } catch (error) { toast.error(driveErrorMessage(error)); }
      }
      if (files.length) onFiles(files);
    } catch (error) {
      if (!(error instanceof Error && error.message === 'DRIVE_DENIED')) toast.error(driveErrorMessage(error));
    } finally { setBusy(false); }
  }
  return <button type="button" className={styles.pick} disabled={disabled || busy} onClick={() => void pick()}>
    {busy ? '正在从 Google 云端硬盘读取…' : '从 Google 云端硬盘选择'}</button>;
}
