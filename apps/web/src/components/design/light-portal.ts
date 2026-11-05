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
export const lightPanelStyle = {
  background: 'var(--gl-surface)', borderColor: 'var(--gl-border)', color: 'var(--gl-text)', boxShadow: 'var(--gl-shadow-dialog)',
} as const;
export const lightDialogStyle = { ...lightPanelStyle, borderRadius: 'var(--gl-radius-dialog)' } as const;
export const lightMenuStyle = { ...lightPanelStyle, borderRadius: 'var(--gl-radius-control)', boxShadow: 'var(--gl-shadow-menu)' } as const;
