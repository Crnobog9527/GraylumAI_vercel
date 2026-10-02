/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** DOM id of the page's ModelMultiplierPanel card on /admin/models. */
export const MULTIPLIER_PANEL_ID = 'model-multipliers';
/** Long enough for a closing dialog to finish restoring focus to its trigger. */
const AFTER_DIALOG_CLOSE_MS = 300;

/** Closes the current dialog, then scrolls to and focuses the multiplier panel. */
export function showMultiplierPanel(closeDialog: () => void) {
  closeDialog();
  window.setTimeout(() => {
    const panel = document.getElementById(MULTIPLIER_PANEL_ID);
    panel?.scrollIntoView({ block: 'start' });
    panel?.focus({ preventScroll: true });
  }, AFTER_DIALOG_CLOSE_MS);
}
