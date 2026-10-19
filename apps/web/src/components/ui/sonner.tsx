'use client';

import type { CSSProperties } from 'react';
import { Toaster as Sonner, toast } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

// The toaster is mounted once in the root layout, outside every `.light` scope, so the --gl-* tokens are
// not defined here. A white toast with the light-foundation values (DESIGN.md) reads on the white workbench
// and public pages and stays readable on the older dark pages.
const toastVars = {
  '--normal-bg': '#fff',
  '--normal-text': '#262626',
  '--normal-border': '#e5e5e5',
  '--success-bg': '#f1f7f2',
  '--success-text': '#2f6a3b',
  '--success-border': '#d3e5d7',
  '--error-bg': '#fcf1f1',
  '--error-text': '#a23b3b',
  '--error-border': '#efd0d0',
  '--warning-bg': '#faf6ee',
  '--warning-text': '#76592a',
  '--warning-border': '#eadfc6',
  '--info-bg': '#fff',
  '--info-text': '#2563a8',
  '--info-border': '#e5e5e5',
} as CSSProperties;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={toastVars}
      toastOptions={{
        classNames: {
          description: 'group-[.toast]:text-[#6b6b6b]',
          actionButton: 'group-[.toast]:bg-[#262626] group-[.toast]:text-white',
          cancelButton: 'group-[.toast]:bg-[#f4f4f5] group-[.toast]:text-[#444]',
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
