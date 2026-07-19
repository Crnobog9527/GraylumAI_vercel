import { describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_LINK_LABEL,
  buildAnnouncementPresentationPayload,
  getAnnouncementLinkFormValue,
} from './announcementFormPayload';

describe('admin announcement presentation payload', () => {
  it('submits a non-empty homepage link without banner styling', () => {
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'promo',
        bannerLink: '  https://example.com/homepage  ',
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: 'https://example.com/homepage',
    });
    expect(ANNOUNCEMENT_LINK_LABEL).toBe('跳转链接（可选）');
  });

  it('preserves the existing banner link and style behavior', () => {
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'banner',
        bannerStyle: 'warning',
        bannerLink: '  https://example.com/banner  ',
      }),
    ).toEqual({
      bannerStyle: 'warning',
      bannerLink: 'https://example.com/banner',
    });
  });

  it('normalizes a blank link to null when creating an announcement', () => {
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'info',
        bannerLink: '   ',
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: null,
    });
  });

  it('submits null when an existing homepage link is cleared', () => {
    const bannerLink = getAnnouncementLinkFormValue(
      'https://example.com/existing-homepage',
    );

    expect(bannerLink).toBe('https://example.com/existing-homepage');
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'info',
        bannerLink: '   ',
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: null,
    });
  });

  it('keeps an existing homepage link when editing and saving', () => {
    const bannerLink = getAnnouncementLinkFormValue(
      'https://example.com/existing-homepage',
    );

    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'info',
        bannerLink,
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: 'https://example.com/existing-homepage',
    });
  });

  it('maps absent database links to an empty form value', () => {
    expect(getAnnouncementLinkFormValue(null)).toBe('');
    expect(getAnnouncementLinkFormValue(undefined)).toBe('');
  });
});
