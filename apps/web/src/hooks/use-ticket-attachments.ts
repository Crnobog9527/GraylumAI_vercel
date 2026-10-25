/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { logClientDevError } from '@/lib/client-log';
import { createClient } from '@/lib/supabase';

export interface PendingAttachment {
  name: string;
  path: string;
  previewUrl: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

/** Ticket screenshot uploads through /api/upload; a refused upload (e.g. a per-user limit) shows the server's message. */
export function useTicketAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    setUploadError(null);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        logClientDevError('Not authenticated');
        return;
      }

      for (const file of files) {
        if (!file.type.startsWith('image/') || file.size > MAX_BYTES) {
          continue;
        }

        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}` },
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          const previewUrl = URL.createObjectURL(file);
          setAttachments(prev => [...prev, { name: file.name, path: data.path, previewUrl }]);
          continue;
        }
        logClientDevError('Upload failed', { status: response.status });
        if (response.status === 429) {
          const result = await response.json().catch(() => null);
          setUploadError(typeof result?.error === 'string' ? result.error : '上传太频繁，请稍后再试');
          // Later files would be refused by the same limit.
          break;
        }
        setUploadError('有附件上传失败，请稍后重试');
      }
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => {
      const target = prev[index];
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }

      return prev.filter((_, i) => i !== index);
    });
  };

  return { attachments, uploading, uploadError, handleFileUpload, removeAttachment };
}
