/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ReportModelSetting } from './ReportModelSetting';
import { SocialMediaFlagSetting } from './SocialMediaFlagSetting';
import { syncModuleVersion } from '@/app/admin/prompts/module-version-sync';

type Versioned = { id: string; updated_at: string };
type Dashboard = { modules?: Versioned[] | null; prompts?: Versioned[] | null } | undefined;

/** Per-module settings saved on their own, outside the Skill publication form. */
export function ModuleSettings<T extends Versioned>({ editing, setEditing, refetch, hasReport }: {
  editing: T | null; setEditing: (update: (current: T | null) => T | null) => void;
  refetch: () => Promise<{ data?: Dashboard }>; hasReport: boolean;
}) {
  const moduleId = editing?.id;
  return <>
    <ReportModelSetting moduleId={moduleId} hasReport={hasReport}
      onSaved={() => syncModuleVersion<T>(refetch, moduleId, setEditing)} />
    <SocialMediaFlagSetting moduleId={moduleId} moduleUpdatedAt={editing?.updated_at}
      onVersion={updatedAt => setEditing(current => (current && current.id === moduleId ? { ...current, updated_at: updatedAt } : current))} />
  </>;
}
