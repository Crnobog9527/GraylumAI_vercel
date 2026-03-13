import type { SupabaseClient } from '@supabase/supabase-js';

export const TICKET_ATTACHMENT_BUCKET = 'ticket-attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 30;

export function normalizeAttachmentStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function isLegacyPublicAttachmentUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function issueSignedAttachmentUrls(
  supabaseAdmin: SupabaseClient,
  value: unknown
): Promise<string[]> {
  const attachments = normalizeAttachmentStrings(value);

  if (attachments.length === 0) {
    return [];
  }

  const signed = await Promise.allSettled(
    attachments.map(async (attachment) => {
      if (isLegacyPublicAttachmentUrl(attachment)) {
        return attachment;
      }

      const { data, error } = await supabaseAdmin.storage
        .from(TICKET_ATTACHMENT_BUCKET)
        .createSignedUrl(attachment, SIGNED_URL_TTL_SECONDS);

      if (error || !data?.signedUrl) {
        console.error('Failed to create signed ticket attachment URL:', attachment, error?.message);
        return null;
      }

      return data.signedUrl;
    })
  );

  return signed.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
}
