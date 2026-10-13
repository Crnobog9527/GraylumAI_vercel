'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CONVERSATION_ERASURE_WARNING } from '@/lib/conversation-erasure';

const panelStyle = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' };
const ghostStyle = { background: 'transparent', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' };
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
    <DialogContent className="sm:max-w-md" style={panelStyle}>
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
