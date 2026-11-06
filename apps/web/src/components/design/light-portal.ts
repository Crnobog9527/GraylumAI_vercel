import light from '@/components/design/light-tokens.module.css';

/*
 * Radix Dialog, AlertDialog, Sheet and Select render into <body>, outside the workbench's `.workspace` scope, so they get the dark root
 * values. A caller on a light page passes `tone="light"` and the content carries its own `.light` tokens (DESIGN.md "Light foundation":
 * white panel, 18px radius for dialogs, the dialog shadow) and a lighter backdrop. The panel is set inline because `.light` also paints a
 * background and the utility classes would only win by stylesheet order. Without the prop nothing changes (dark pages keep their look).
 */
export type PortalTone = 'light';
export const lightPortalClass = light.light;
export const lightOverlayClass = 'bg-black/40';
/*
 * Inside the panel the workbench aliases keep the signed-in baseline's caption grey (DESIGN.md "Signed-in baseline": secondary and
 * tertiary text are #6b6b6b, `--gl-text-secondary-aa`); `.light` alone would give #777 / #999, which fail 4.5:1 on the white panel.
 */
export const lightPanelStyle = {
  background: 'var(--gl-surface)', borderColor: 'var(--gl-border)', color: 'var(--gl-text)', boxShadow: 'var(--gl-shadow-dialog)',
  '--text-secondary': 'var(--gl-text-secondary-aa)', '--text-tertiary': 'var(--gl-text-secondary-aa)',
} as const;
export const lightDialogStyle = { ...lightPanelStyle, borderRadius: 'var(--gl-radius-dialog)' } as const;
export const lightMenuStyle = { ...lightPanelStyle, borderRadius: 'var(--gl-radius-control)', boxShadow: 'var(--gl-shadow-menu)' } as const;
