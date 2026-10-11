/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ReportModelSetting } from './ReportModelSetting';
import { SocialMediaFlagSetting } from './SocialMediaFlagSetting';

/** Per-module settings saved on their own, outside the Skill publication form. */
export function ModuleSettings({ moduleId, hasReport, onSaved }: {
  moduleId: string | undefined; hasReport: boolean; onSaved?: () => Promise<boolean>;
}) {
  return <>
    <ReportModelSetting moduleId={moduleId} hasReport={hasReport} onSaved={onSaved} />
    <SocialMediaFlagSetting moduleId={moduleId} onSaved={onSaved} />
  </>;
}
