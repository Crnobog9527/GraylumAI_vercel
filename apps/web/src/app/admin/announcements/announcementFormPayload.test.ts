import { describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_LINK_LABEL,
  buildAnnouncementPresentationPayload,
  getAnnouncementLinkFormValue,
} from './announcementFormPayload';

describe('admin announcement presentation payload', () => {
  it('submits the banner link and style', () => {
    expect(
      buildAnnouncementPresentationPayload({
        bannerStyle: 'warning',
        bannerLink: '  https://example.com/banner  ',
      }),
    ).toEqual({
      bannerStyle: 'warning',
      bannerLink: '  https://example.com/banner  ',
    });
    expect(ANNOUNCEMENT_LINK_LABEL).toBe('跳转链接（可选）');
  });

  it('uses null only when the link field is completely empty', () => {
    expect(
      buildAnnouncementPresentationPayload({
        bannerStyle: 'info',
        bannerLink: '',
      }),
    ).toEqual({
      bannerStyle: 'info',
      bannerLink: null,
    });
  });

  it('submits null when an existing banner link is cleared', () => {
    const bannerLink = getAnnouncementLinkFormValue(
      'https://example.com/existing-banner',
    );

    expect(bannerLink).toBe('https://example.com/existing-banner');
    expect(
      buildAnnouncementPresentationPayload({
        bannerStyle: 'info',
        bannerLink: '',
      }),
    ).toEqual({
      bannerStyle: 'info',
      bannerLink: null,
    });
  });

  it('keeps an existing banner link when editing and saving', () => {
    const bannerLink = getAnnouncementLinkFormValue(
      'https://example.com/existing-banner',
    );

    expect(
      buildAnnouncementPresentationPayload({
        bannerStyle: 'promo',
        bannerLink,
      }),
    ).toEqual({
      bannerStyle: 'promo',
      bannerLink: 'https://example.com/existing-banner',
    });
  });

  it('preserves whitespace-only input for server rejection', () => {
    expect(buildAnnouncementPresentationPayload({ bannerStyle: 'info', bannerLink: '   ' }).bannerLink).toBe('   ');
  });

  it('maps absent database links to an empty form value', () => {
    expect(getAnnouncementLinkFormValue(null)).toBe('');
    expect(getAnnouncementLinkFormValue(undefined)).toBe('');
  });
});
