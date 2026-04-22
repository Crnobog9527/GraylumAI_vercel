import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';

export const TICKET_ATTACHMENT_BUCKET = 'ticket-attachments';
const SIGNED_URL_TTL_SECONDS = 60 * 30;
const ATTACHMENT_PATH_TRAVERSAL_PATTERN = /(^|\/)\.\.(\/|$)/;

export function normalizeAttachmentStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function isLegacyPublicAttachmentUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeOwnerIds(ownerIds: Array<string | null | undefined>): string[] {
  return ownerIds.filter((ownerId): ownerId is string => typeof ownerId === 'string' && ownerId.trim().length > 0);
}

export function isOwnedTicketAttachmentPath(
  value: string,
  ownerIds: Array<string | null | undefined>
): boolean {
  if (!value || value.startsWith('/') || ATTACHMENT_PATH_TRAVERSAL_PATTERN.test(value) || isLegacyPublicAttachmentUrl(value)) {
    return false;
  }

  const normalizedOwnerIds = normalizeOwnerIds(ownerIds);
  if (normalizedOwnerIds.length === 0) {
    return false;
  }

  return normalizedOwnerIds.some((ownerId) => value.startsWith(`${ownerId}/`));
}

export function filterOwnedTicketAttachmentPaths(
  value: unknown,
  ownerIds: Array<string | null | undefined>
): string[] {
  return normalizeAttachmentStrings(value).filter((attachment) =>
    isOwnedTicketAttachmentPath(attachment, ownerIds)
  );
}

type AttachmentBatchInput = {
  key: string;
  value: unknown;
  ownerIds?: Array<string | null | undefined>;
};

async function createSignedAttachmentUrlLookup(
  supabaseAdmin: SupabaseClient,
  batches: AttachmentBatchInput[],
) {
  const signedUrlPromises = new Map<string, Promise<string | null>>();

  const resolveSignedUrl = (attachment: string, ownerIds: Array<string | null | undefined>) => {
    if (isLegacyPublicAttachmentUrl(attachment)) {
      return Promise.resolve(attachment);
    }

    const normalizedOwnerIds = normalizeOwnerIds(ownerIds);
    if (normalizedOwnerIds.length > 0 && !isOwnedTicketAttachmentPath(attachment, normalizedOwnerIds)) {
      return Promise.resolve(null);
    }

    const existing = signedUrlPromises.get(attachment);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const { data, error } = await supabaseAdmin.storage
        .from(TICKET_ATTACHMENT_BUCKET)
        .createSignedUrl(attachment, SIGNED_URL_TTL_SECONDS);

      if (error || !data?.signedUrl) {
        logger.error('api', 'ticket_attachment_signed_url_failed');
        return null;
      }

      return data.signedUrl;
    })();

    signedUrlPromises.set(attachment, promise);
    return promise;
  };

  const signedBatches = await Promise.all(
    batches.map(async (batch) => {
      const attachments = normalizeAttachmentStrings(batch.value);
      if (attachments.length === 0) {
        return [batch.key, [] as string[]] as const;
      }

      const resolvedUrls = await Promise.all(
        attachments.map((attachment) => resolveSignedUrl(attachment, batch.ownerIds ?? [])),
      );

      return [
        batch.key,
        resolvedUrls.filter((url): url is string => typeof url === 'string' && url.length > 0),
      ] as const;
    }),
  );

  return new Map<string, string[]>(signedBatches);
}

export async function issueSignedAttachmentUrlsByBatch(
  supabaseAdmin: SupabaseClient,
  batches: AttachmentBatchInput[],
): Promise<Map<string, string[]>> {
  if (batches.length === 0) {
    return new Map();
  }

  return createSignedAttachmentUrlLookup(supabaseAdmin, batches);
}

export async function issueSignedAttachmentUrls(
  supabaseAdmin: SupabaseClient,
  value: unknown,
  ownerIds: Array<string | null | undefined> = []
): Promise<string[]> {
  const signedBatches = await issueSignedAttachmentUrlsByBatch(supabaseAdmin, [
    {
      key: 'default',
      value,
      ownerIds,
    },
  ]);

  return signedBatches.get('default') ?? [];
}
