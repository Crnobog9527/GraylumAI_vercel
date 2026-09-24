/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { redirect } from 'next/navigation';

/** Preserve old plan deep links on the current topic workspace. */
export default async function LegacyPlan({params}:{params:Promise<{draftId:string}>}) {
  const {draftId}=await params;
  redirect(`/positioning/${encodeURIComponent(draftId)}/topics`);
}
