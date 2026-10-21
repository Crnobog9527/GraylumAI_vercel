/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

type Versioned = { id: string; updated_at: string };
type Dashboard = { modules?: Versioned[] | null; prompts?: Versioned[] | null } | undefined;

/**
 * Saving the report model (REPORT-MODEL) also moves the module's `updated_at`, which the Skill
 * form sends back as `expectedUpdatedAt`. Re-read the dashboard and copy only the new version
 * into the module being edited, keeping every unsaved form field. Returns false when the module
 * could not be found again, so the caller can ask the admin to reopen the dialog.
 */
export async function syncModuleVersion<T extends Versioned>(
  refetch: () => Promise<{ data?: Dashboard }>,
  moduleId: string | undefined,
  setEditing: (update: (current: T | null) => T | null) => void,
) {
  if (!moduleId) return false;
  try {
    const { data } = await refetch();
    const fresh = (data?.modules ?? data?.prompts ?? []).find(module => module.id === moduleId);
    if (!fresh) return false;
    setEditing(current => (current && current.id === moduleId ? { ...current, updated_at: fresh.updated_at } : current));
    return true;
  } catch {
    return false;
  }
}
