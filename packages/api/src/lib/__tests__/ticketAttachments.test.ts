import { describe, expect, it, vi } from 'vitest';
import {
  filterOwnedTicketAttachmentPaths,
  isOwnedTicketAttachmentPath,
  issueSignedAttachmentUrls,
  issueSignedAttachmentUrlsByBatch,
} from '../ticketAttachments';

describe('ticket attachment ownership guards', () => {
  it('accepts only attachment paths under the owner prefix', () => {
    expect(isOwnedTicketAttachmentPath('user-1/123.png', ['user-1'])).toBe(true);
    expect(isOwnedTicketAttachmentPath('user-2/123.png', ['user-1'])).toBe(false);
    expect(isOwnedTicketAttachmentPath('../user-1/123.png', ['user-1'])).toBe(false);
    expect(isOwnedTicketAttachmentPath('https://example.com/file.png', ['user-1'])).toBe(false);
  });

  it('filters out unowned or malformed attachment paths before persistence', () => {
    expect(
      filterOwnedTicketAttachmentPaths(
        [
          'user-1/ok.png',
          'user-2/not-ok.png',
          '../escape.png',
          'https://legacy.example.com/public.png',
        ],
        ['user-1'],
      ),
    ).toEqual(['user-1/ok.png']);
  });

  it('skips signing storage objects that do not belong to the allowed owner', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed.example.com/user-1/ok.png' },
      error: null,
    });

    const supabaseAdmin = {
      storage: {
        from: vi.fn().mockReturnValue({
          createSignedUrl,
        }),
      },
    };

    const signedUrls = await issueSignedAttachmentUrls(
      supabaseAdmin as any,
      ['user-1/ok.png', 'user-2/not-ok.png'],
      ['user-1'],
    );

    expect(signedUrls).toEqual(['https://signed.example.com/user-1/ok.png']);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledWith('user-1/ok.png', 60 * 30);
  });

  it('reuses signed URLs across attachment batches to avoid duplicate storage calls', async () => {
    const createSignedUrl = vi.fn().mockImplementation(async (path: string) => ({
      data: { signedUrl: `https://signed.example.com/${path}` },
      error: null,
    }));

    const supabaseAdmin = {
      storage: {
        from: vi.fn().mockReturnValue({
          createSignedUrl,
        }),
      },
    };

    const signedUrls = await issueSignedAttachmentUrlsByBatch(
      supabaseAdmin as any,
      [
        {
          key: 'ticket',
          value: ['user-1/shared.png', 'user-1/ticket-only.png'],
          ownerIds: ['user-1'],
        },
        {
          key: 'reply',
          value: ['user-1/shared.png'],
          ownerIds: ['user-1'],
        },
      ],
    );

    expect(signedUrls.get('ticket')).toEqual([
      'https://signed.example.com/user-1/shared.png',
      'https://signed.example.com/user-1/ticket-only.png',
    ]);
    expect(signedUrls.get('reply')).toEqual([
      'https://signed.example.com/user-1/shared.png',
    ]);
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
  });
});
