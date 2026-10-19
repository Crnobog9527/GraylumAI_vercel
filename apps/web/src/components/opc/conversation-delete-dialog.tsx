'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import light from '@/components/design/light-tokens.module.css';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CONVERSATION_ERASURE_WARNING } from '@/lib/conversation-erasure';

// The dialog is portalled to <body>, outside the workbench's scope, so it carries its own `.light` tokens
// (DESIGN.md Base components: white, 18px radius, dialog shadow).
const panelStyle = {
  background: 'var(--gl-surface)', borderColor: 'var(--gl-border)', color: 'var(--gl-text)',
  borderRadius: 'var(--gl-radius-dialog)', boxShadow: 'var(--gl-shadow-dialog)',
};
const ghostStyle = { background: 'transparent', borderColor: 'var(--gl-border-control)', color: 'var(--gl-text-body)' };
const dangerStyle = { background: '#dc2626', color: '#fff' };

/**
 * Deleting a whole conversation, ChatGPT/Claude style (Owner 2026-10-13): no impact list and no
 * waiting. "删除" is enabled as soon as the dialog opens; the caller closes it and deletes in the background.
 */
export function ConversationDeleteDialog({ name, onConfirm, onCancel }: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent className={`${light.light} sm:max-w-md`} style={panelStyle}>
      <DialogHeader>
        <DialogTitle style={{ color: 'var(--text-primary)' }}>删除对话？</DialogTitle>
        <DialogDescription style={{ color: 'var(--text-secondary)' }}>
          {name ? <>将删除「<span className="break-all">{name}</span>」。</> : null}{CONVERSATION_ERASURE_WARNING}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="gap-2">
        <Button variant="outline" style={ghostStyle} onClick={onCancel}>取消</Button>
        <Button style={dangerStyle} autoFocus onClick={onConfirm}>删除</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
